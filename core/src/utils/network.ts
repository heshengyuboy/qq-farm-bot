export {};
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { CONFIG } = require('../config/config');
const { createScheduler } = require('../services/scheduler');
const { updateStatusFromLogin, updateStatusGold, updateStatusLevel } = require('../services/status');
const { recordOperation } = require('../services/stats');
const { types } = require('./proto');
const { toLong, toNum, syncServerTime, log, logWarn } = require('./utils');
const cryptoWasm = require('./crypto-wasm');
const { createGatewayToken } = require('./gateway-token');
const { startAceRuntime, stopAceRuntime } = require('../services/ace');

// 延迟加载 warehouse 模块避免循环依赖
let warehouseModule: any = null;
function getWarehouseModule(): any {
    if (!warehouseModule) {
        warehouseModule = require('../services/warehouse');
    }
    return warehouseModule;
}

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
type ConnectionPhase = 'connecting' | 'login' | 'online';

interface ConnectionContext {
    id: number;
    socket: WebSocket;
    phase: ConnectionPhase;
    intentionalClose: boolean;
    finalized: boolean;
}

interface SendMsgOptions {
    timeoutMs?: number;
    expectedErrorCodes?: readonly number[];
}

interface PendingRequest {
    callback: (err: Error | null, body?: Buffer, meta?: any) => void;
    expectedErrorCodes: Set<number>;
}

class GatewayError extends Error {
    code: number;
    serviceName: string;
    methodName: string;
    errorMessage: string;
    clientSeq: number;

    constructor(meta: any) {
        const code = toNum(meta && meta.error_code);
        const serviceName = String((meta && meta.service_name) || '');
        const methodName = String((meta && meta.method_name) || '');
        const errorMessage = String((meta && meta.error_message) || '');
        super(`${serviceName}.${methodName} 错误: code=${code} ${errorMessage}`.trim());
        this.name = 'GatewayError';
        this.code = code;
        this.serviceName = serviceName;
        this.methodName = methodName;
        this.errorMessage = errorMessage;
        this.clientSeq = toNum(meta && meta.client_seq);
    }
}

let ws: WebSocket | null = null;
let currentConnection: ConnectionContext | null = null;
let nextConnectionId = 1;
let clientSeq: number = 1;
let serverSeq: number = 0;
const pendingCallbacks = new Map<number, PendingRequest>();
let wsErrorState = { code: 0, at: 0, message: '' };
const networkScheduler = createScheduler('network');

function rejectAllPendingRequests(reason = '请求被中断'): number {
    const entries = Array.from(pendingCallbacks.entries());
    pendingCallbacks.clear();
    for (const [, pending] of entries) {
        try {
            pending.callback(new Error(reason));
        } catch {
            // ignore callback failure
        }
    }
    return entries.length;
}

// ============ 用户状态 (登录后设置) ============
const userState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    coupon: 0,
    goldBean: 0,
    openId: '',
};

function getUserState() { return userState; }
function getWsErrorState() { return { ...wsErrorState }; }
function setWsErrorState(code: number, message: string): void {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: message || '' };
}
function clearWsErrorState(): void {
    wsErrorState = { code: 0, at: 0, message: '' };
}

// 登录后从背包获取金豆豆数量
async function fetchGoldBeanFromBag(): Promise<void> {
    try {
        const warehouse = getWarehouseModule();
        const bagReply = await warehouse.getBag();
        const items = warehouse.getBagItems(bagReply);
        for (const item of (items || [])) {
            const id = toNum(item && item.id);
            const count = toNum(item && item.count);
            if (id === 1005 && count > 0) {
                userState.goldBean = count;
                log('系统', `金豆豆数量: ${count}`);
                break;
            }
        }
    } catch (e) {
        // 忽略获取失败
    }
}

function hasOwn(obj: any, key: string): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// 登录后获取用户设置
async function fetchUserSettings(): Promise<void> {
    try {
        const body = types.GetUserSettingsRequest.encode(types.GetUserSettingsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.userpb.UserService', 'GetUserSettings', body);
        const reply = types.GetUserSettingsReply.decode(replyBody);
        if (reply.settings) {
            log('系统', `用户设置已同步`);
        }
    } catch (e) {
        // 忽略获取失败
    }
}

// ============ 消息编解码 ============
async function encodeMsg(serviceName: string, methodName: string, bodyBytes: Buffer, clientSeqValue: number): Promise<Buffer> {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        finalBody = await cryptoWasm.encryptBuffer(finalBody);
    }
    const msg = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeqValue),
            server_seq: toLong(serverSeq),
        },
        body: finalBody,
        token: createGatewayToken(),
    });
    return types.GateMessage.encode(msg).finish();
}

function isCurrentConnection(context: ConnectionContext): boolean {
    return currentConnection === context && ws === context.socket && !context.finalized;
}

async function sendMsg(context: ConnectionContext, serviceName: string, methodName: string, bodyBytes: Buffer, pending?: PendingRequest): Promise<boolean> {
    if (!isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
        log('系统', '[WS] 连接未打开');
        return false;
    }
    const seq = clientSeq;
    clientSeq += 1;
    const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
    if (!isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
        return false;
    }
    if (pending) pendingCallbacks.set(seq, pending);
    try {
        context.socket.send(encoded);
    } catch (err: any) {
        if (pending) {
            pendingCallbacks.delete(seq);
            pending.callback(err);
        }
        return false;
    }
    return true;
}

/** Promise 版发送 */
function sendMsgAsync(serviceName: string, methodName: string, bodyBytes: Buffer, timeoutOrOptions: number | SendMsgOptions = 20000): Promise<{ body: Buffer; meta: any }> {
    const options: SendMsgOptions = typeof timeoutOrOptions === 'number'
        ? { timeoutMs: timeoutOrOptions }
        : (timeoutOrOptions || {});
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20000);
    const expectedErrorCodes = new Set((options.expectedErrorCodes || []).map(Number).filter(Number.isFinite));
    return new Promise((resolve, reject) => {
        const context = currentConnection;
        if (!context || !isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开: ${methodName}`));
            return;
        }
        if (context.phase !== 'online') {
            reject(new Error(`账号尚未登录: ${methodName}`));
            return;
        }

        if (pendingCallbacks.size >= 5) {
            reject(new Error(`请求队列已满: ${methodName} (pending=${pendingCallbacks.size})`));
            return;
        }

        const seq = clientSeq;
        const timeoutKey = `request_timeout_${seq}`;
        networkScheduler.setTimeoutTask(timeoutKey, timeoutMs, () => {
            pendingCallbacks.delete(seq);
            const pending = pendingCallbacks.size;
            reject(new Error(`请求超时: ${methodName} (seq=${seq}, pending=${pending})`));
        });

        sendMsg(context, serviceName, methodName, bodyBytes, {
            expectedErrorCodes,
            callback: (err, body, meta) => {
                networkScheduler.clear(timeoutKey);
                if (err) reject(err);
                else resolve({ body: body!, meta });
            },
        }).then((sent) => {
            if (sent) return;
            networkScheduler.clear(timeoutKey);
            pendingCallbacks.delete(seq);
            reject(new Error(`发送失败: ${methodName}`));
        }).catch((e: any) => {
            networkScheduler.clear(timeoutKey);
            pendingCallbacks.delete(seq);
            reject(e);
        });
    });
}

async function sendMsgNoReply(serviceName: string, methodName: string, bodyBytes: Buffer): Promise<void> {
    const context = currentConnection;
    if (!context || !isCurrentConnection(context) || context.socket.readyState !== WebSocket.OPEN) {
        throw new Error(`连接未打开: ${methodName}`);
    }
    if (context.phase !== 'online') {
        throw new Error(`账号尚未登录: ${methodName}`);
    }
    if (!await sendMsg(context, serviceName, methodName, bodyBytes)) {
        throw new Error(`发送失败: ${methodName}`);
    }
}

// ============ 消息处理 ============
function handleMessage(data: Buffer): void {
    try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const msg = types.GateMessage.decode(buf);
        const meta = msg.meta;
        if (!meta) return;

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = meta.message_type;

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const pending = pendingCallbacks.get(clientSeqVal);
            const expectedError = !!pending && pending.expectedErrorCodes.has(errorCode);
            if (errorCode !== 0 && !expectedError) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }

            if (pending) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    pending.callback(new GatewayError(meta));
                } else {
                    pending.callback(null, msg.body, meta);
                }
                return;
            }
        }
    } catch (err: any) {
        logWarn('解码', err.message);
    }
}

function handleNotify(msg: any): void {
    if (!msg.body || msg.body.length === 0) return;
    try {
        const event = types.EventMessage.decode(msg.body);
        const type = event.message_type || '';
        const eventBody = event.body;

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = types.KickoutNotify.decode(eventBody);
                log('推送', `原因: ${notify.reason_message || '未知'}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: notify.reason_message || '未知',
                });
            } catch {}
            return;
        }

        // 土地状态变化
        if (type.includes('LandsNotify')) {
            try {
                const notify = types.LandsNotify.decode(eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = notify.lands || [];
                if (lands.length > 0) {
                    if (hostGid === userState.gid || hostGid === 0) {
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch {}
            return;
        }

        // 物品变化通知
        if (type.includes('ItemNotify')) {
            try {
                const notify = types.ItemNotify.decode(eventBody);
                const items = notify.items || [];
                for (const itemChg of items) {
                    const item = itemChg.item;
                    if (!item) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);

                    if (id === 1101) {
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if (id === 1005) {
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    }
                }
            } catch {}
            return;
        }

        // 基本信息变化
        if (type.includes('BasicNotify')) {
            try {
                const notify = types.BasicNotify.decode(eventBody);
                if (notify.basic) {
                    const oldLevel = userState.level;
                    if (hasOwn(notify.basic, 'level')) {
                        const nextLevel = toNum(notify.basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(notify.basic, 'gold')) {
                        const nextGold = toNum(notify.basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(notify.basic, 'exp')) {
                        const exp = toNum(notify.basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch {}
            return;
        }

        // 好友申请通知
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = types.FriendApplicationReceivedNotify.decode(eventBody);
                const applications = notify.applications || [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch {}
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = types.FriendAddedNotify.decode(eventBody);
                const friends = notify.friends || [];
                if (friends.length > 0) {
                    const names = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch {}
            return;
        }

        // 商品解锁通知
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = types.GoodsUnlockNotify.decode(eventBody);
                const goods = notify.goods_list || [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch {}
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = types.TaskInfoNotify.decode(eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch {}
            return;
        }

        // VIP信息更新通知
        if (type.includes('VipInfoUpdatedNTF')) {
            try {
                const notify = types.VipInfoUpdatedNTF.decode(eventBody);
                networkEvents.emit('vipInfoUpdated', notify);
            } catch {}
            return;
        }

        // 商城需求通知
        if (type.includes('NeedNotify')) {
            try {
                const notify = types.NeedNotify.decode(eventBody);
                networkEvents.emit('mallNeedNotify', notify);
            } catch {}
            return;
        }

        // 商品变更通知
        if (type.includes('ProductsHasChangedNotify')) {
            try {
                const notify = types.ProductsHasChangedNotify.decode(eventBody);
                networkEvents.emit('productsChanged', notify);
            } catch {}
            return;
        }

        // 活动变更通知
        if (type.includes('ActiviesChangeNotify')) {
            try {
                const notify = types.ActiviesChangeNotify.decode(eventBody);
                networkEvents.emit('activitiesChanged', notify);
            } catch {}
            return;
        }

        // 头像框红点通知
        if (type.includes('AvatarFrameRedDotNotify')) {
            try {
                networkEvents.emit('avatarFrameRedDot');
            } catch {}
            return;
        }

        // 图鉴奖励红点通知
        if (type.includes('IllustratedRewardRedDotNotifyV2')) {
            try {
                networkEvents.emit('illustratedRewardRedDot');
            } catch {}
            return;
        }

        // 充值信息变更通知
        if (type.includes('RechargeInfoNotify')) {
            try {
                const notify = types.RechargeInfoNotify.decode(eventBody);
                networkEvents.emit('rechargeInfoChanged', notify);
            } catch {}
            return;
        }

        // 公告板变更通知
        if (type.includes('BulletinListChangedNTF')) {
            try {
                const notify = types.BulletinListChangedNTF.decode(eventBody);
                networkEvents.emit('bulletinListChanged', notify);
            } catch {}
            return;
        }

        // 皮肤变更通知
        if (type.includes('SkinChangeNotify')) {
            try {
                const notify = types.SkinChangeNotify.decode(eventBody);
                networkEvents.emit('skinChanged', notify);
            } catch {}
            return;
        }
    } catch (e: any) {
        logWarn('推送', `解码失败: ${e.message}`);
    }
}

// ============ 登录 ============
async function sendLogin(context: ConnectionContext, onLoginSuccess?: () => void): Promise<void> {
    const di = CONFIG.deviceInfo || {};
    const body = types.LoginRequest.encode(types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: di.clientVersion || CONFIG.clientVersion,
            sys_software: di.sysSoftware || 'Windows',
            screen_width: 0,
        },
        share_cfg_id: toLong(0),
        scene_id: '1234567',
        report_data: {
            minigame_channel: 'other-qq',
            minigame_platid: 2,
        },
    })).finish();

    await sendMsg(context, 'gamepb.userpb.UserService', 'Login', body, {
        expectedErrorCodes: new Set(),
        callback: async (err, bodyBytes, _meta) => {
        if (!isCurrentConnection(context)) return;
        if (err) {
            log('登录', `失败: ${err.message}`);
            if (err.message.includes('code=')) {
                log('系统', '账号验证失败，即将停止运行...');
                networkScheduler.setTimeoutTask('login_error_exit', 1000, () => process.exit(0));
            }
            return;
        }

        let reply: any;
        try {
            reply = types.LoginReply.decode(bodyBytes!);
        } catch (e: any) {
            log('登录', `解码失败: ${e.message}`);
            return;
        }
        if (!reply.basic) {
            log('登录', '失败: 登录响应缺少账号信息');
            return;
        }

        clearWsErrorState();
        userState.gid = toNum(reply.basic.gid);
        userState.name = reply.basic.name || '未知';
        userState.level = toNum(reply.basic.level);
        userState.gold = toNum(reply.basic.gold);
        userState.exp = toNum(reply.basic.exp);
        userState.openId = String(reply.basic.open_id || '').trim();

        updateStatusFromLogin({
            name: userState.name,
            level: userState.level,
            gold: userState.gold,
            exp: userState.exp,
        });

        log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

        console.warn('');
        console.warn('========== 登录成功 ==========');
        console.warn(`  GID:    ${userState.gid}`);
        console.warn(`  昵称:   ${userState.name}`);
        console.warn(`  等级:   ${userState.level}`);
        console.warn(`  金币:   ${userState.gold}`);
        if (reply.time_now_millis) {
            syncServerTime(toNum(reply.time_now_millis));
            console.warn(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
        }
        console.warn('===============================');
        console.warn('');

        try {
            if (userState.openId) {
                await cryptoWasm.bindUser(userState.openId);
            }
            if (!isCurrentConnection(context)) return;
            networkScheduler.clear('login_timeout');
            context.phase = 'online';
            startAceRuntime(sendMsgAsync);
            fetchGoldBeanFromBag();
            fetchUserSettings();
            startHeartbeat(context);
            if (onLoginSuccess) onLoginSuccess();
        } catch (e: any) {
            logWarn('登录', `登录初始化失败: ${e.message}`);
            finalizeConnection(context, {
                source: 'login_init_failed',
                reason: e.message,
            });
            try { (context.socket as any).terminate(); } catch {}
        }
        },
    });
}

// ============ 心跳 ============
let lastHeartbeatResponse = Date.now();
let heartbeatMissCount = 0;
const HEARTBEAT_TIMEOUT = 30000;
const MAX_HEARTBEAT_MISS = 1;

function startHeartbeat(context: ConnectionContext): void {
    networkScheduler.clear('heartbeat_interval');
    lastHeartbeatResponse = Date.now();
    heartbeatMissCount = 0;

    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => {
        if (!isCurrentConnection(context) || context.phase !== 'online' || !userState.gid) return;

        const timeSinceLastResponse = Date.now() - lastHeartbeatResponse;
        if (timeSinceLastResponse > HEARTBEAT_TIMEOUT) {
            heartbeatMissCount++;
            logWarn('心跳', `连接可能已断开 (${Math.round(timeSinceLastResponse / 1000)}s 无响应, pending=${pendingCallbacks.size})`);
            if (heartbeatMissCount >= MAX_HEARTBEAT_MISS) {
                log('心跳', '心跳超时，账号将停止运行...');
                finalizeConnection(context, {
                    source: 'heartbeat_timeout',
                    reason: `${Math.round(timeSinceLastResponse / 1000)}s 无响应`,
                });
                try { (context.socket as any).terminate(); } catch {}
                return;
            }
        }

        const body = types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
            gid: toLong(userState.gid),
            client_version: CONFIG.clientVersion,
        })).finish();
        sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', body).then(({ body: replyBody }) => {
            if (!isCurrentConnection(context)) return;
            lastHeartbeatResponse = Date.now();
            heartbeatMissCount = 0;
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch {}
        }).catch(() => {});
    });
}

interface DisconnectDetails {
    source: string;
    code?: number;
    reason?: string;
}

function clearNetworkRuntime(reason: string): void {
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    stopAceRuntime(true);
    userState.gid = 0;
    userState.openId = '';
}

function finalizeConnection(context: ConnectionContext, details: DisconnectDetails): void {
    if (context.finalized) return;
    context.finalized = true;
    const wasCurrent = currentConnection === context;
    const wasLoginReady = context.phase === 'online';
    if (wasCurrent) {
        currentConnection = null;
        ws = null;
        clearNetworkRuntime(details.reason || details.source);
    }
    if (!wasCurrent || context.intentionalClose) return;
    networkEvents.emit('disconnected', {
        connectionId: context.id,
        source: details.source,
        code: Number(details.code) || 0,
        reason: details.reason || '',
        phase: context.phase,
        wasLoginReady,
        at: Date.now(),
    });
}

// ============ WebSocket 连接 ============
function connect(code: string | null, onLoginSuccess?: () => void): void {
    const authCode = String(code || '').trim();
    if (!authCode) throw new Error('连接缺少一次性 Code');
    if (currentConnection && !currentConnection.finalized) throw new Error('WebSocket 连接已存在');

    clientSeq = 1;
    serverSeq = 0;
    const url = new URL(CONFIG.serverUrl);
    url.search = new URLSearchParams({
        platform: CONFIG.platform,
        os: CONFIG.os,
        ver: CONFIG.clientVersion,
        code: authCode,
    }).toString();
    const di = CONFIG.deviceInfo || {};
    const socket = new WebSocket(url.toString(), {
        headers: {
            'User-Agent': di.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
            'Origin': 'https://gate-obt.nqf.qq.com',
        },
    });
    const context: ConnectionContext = {
        id: nextConnectionId++,
        socket,
        phase: 'connecting',
        intentionalClose: false,
        finalized: false,
    };
    currentConnection = context;
    ws = socket;
    socket.binaryType = 'arraybuffer';

    (socket as any).on('open', () => {
        if (!isCurrentConnection(context)) return;
        context.phase = 'login';
        networkScheduler.setTimeoutTask('login_timeout', 20000, () => {
            if (!isCurrentConnection(context) || context.phase !== 'login') return;
            logWarn('登录', '登录响应超时，账号将停止运行...');
            finalizeConnection(context, { source: 'login_timeout', reason: '登录响应超时' });
            try { (socket as any).terminate(); } catch {}
        });
        sendLogin(context, onLoginSuccess).catch((e: any) => {
            if (!isCurrentConnection(context)) return;
            finalizeConnection(context, { source: 'login_send_failed', reason: e.message });
            try { (socket as any).terminate(); } catch {}
        });
    });

    (socket as any).on('message', (data: any, _isBinary: any) => {
        if (!isCurrentConnection(context)) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        handleMessage(buf);
    });

    (socket as any).on('close', (closeCode: any, closeReason: any) => {
        const reason = Buffer.isBuffer(closeReason) ? closeReason.toString('utf8') : String(closeReason || '');
        console.warn(`[WS] 连接关闭 (code=${closeCode})`);
        finalizeConnection(context, { source: 'ws_close', code: Number(closeCode) || 0, reason });
    });

    (socket as any).on('error', (err: any) => {
        if (!isCurrentConnection(context)) return;
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const errorCode = Number.parseInt(match[1], 10) || 0;
            if (errorCode) {
                setWsErrorState(errorCode, message);
                networkEvents.emit('ws_error', { code: errorCode, message });
            }
        }
    });
}

function cleanup(reason = '网络清理'): void {
    const context = currentConnection;
    if (!context) {
        clearNetworkRuntime(reason);
        return;
    }
    context.intentionalClose = true;
    finalizeConnection(context, { source: 'intentional_close', reason });
    try { context.socket.close(); } catch {}
}

function getWs(): WebSocket | null { return ws; }

module.exports = {
    connect, cleanup, getWs,
    sendMsgAsync, sendMsgNoReply,
    GatewayError,
    getUserState,
    getWsErrorState,
    networkEvents,
};
