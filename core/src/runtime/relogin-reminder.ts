export {};
const fs = require('node:fs');
const path = require('node:path');
const { sleep } = require('../utils/utils');
const { getDataDir } = require('../config/runtime-paths');
const { getRuntimeConfig, CONFIG } = require('../config/config');

const WX_LOGIN_APP_ID = 'wx5306c5978fdb76e4';

interface ReloginReminderOptions {
    store: any;
    miniProgramLoginSession: any;
    wxLoginService?: any;
    adminPort?: number;
    sendPushooMessage: (payload: any) => Promise<any>;
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    getAccounts: () => any;
    addOrUpdateAccount: (acc: any) => any;
    resolveWorkerControls: () => any;
}

interface ReloginCodePayload {
    accountId?: string;
    accountName?: string;
    authCode?: string;
    uin?: string;
}

interface OfflineReminderPayload {
    accountId?: string;
    accountName?: string;
    username?: string;
    reason?: string;
    offlineMs?: number;
    platform?: string;
}

function createReloginReminderService(options: ReloginReminderOptions) {
    const {
        store,
        miniProgramLoginSession,
        wxLoginService,
        adminPort,
        sendPushooMessage,
        log,
        addAccountLog,
        getAccounts,
        addOrUpdateAccount,
        resolveWorkerControls,
    } = options;

    const reloginWatchers = new Map<string, { startedAt: number }>();
    const wxReloginWatchers = new Map<string, { startedAt: number }>();

    function getOfflineAutoDeleteMs(username = ''): number {
        const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
        const sec = Math.max(0, Number.parseInt(cfg && cfg.offlineDeleteSec, 10) || 0);
        if (sec === 0) return Infinity;
        return sec * 1000;
    }

    function applyReloginCode({ accountId = '', accountName = '', authCode = '', uin = '' }: ReloginCodePayload): void {
        const code = String(authCode || '').trim();
        if (!code) return;

        const data = getAccounts();
        const list = Array.isArray(data.accounts) ? data.accounts : [];
        const found = list.find((a: any) => String(a.id) === String(accountId));
        const avatar = uin ? `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=640` : '';
        const controls = (typeof resolveWorkerControls === 'function') ? (resolveWorkerControls() || {}) : {};
        const startWorker = typeof controls.startWorker === 'function' ? controls.startWorker : null;
        const restartWorker = typeof controls.restartWorker === 'function' ? controls.restartWorker : null;

        if (found) {
            addOrUpdateAccount({
                id: found.id,
                name: found.name,
                code,
                platform: found.platform || 'qq',
                qq: uin || found.qq || found.uin || '',
                uin: uin || found.uin || found.qq || '',
                avatar: avatar || found.avatar || '',
            });
            if (restartWorker) {
                restartWorker({
                    ...found,
                    code,
                    qq: uin || found.qq || found.uin || '',
                    uin: uin || found.uin || found.qq || '',
                    avatar: avatar || found.avatar || '',
                });
            }
            addAccountLog('update', `重登录成功，已更新账号: ${found.name}`, found.id, found.name, { reason: 'relogin' });
            log('系统', `重登录成功，账号已更新并重启: ${found.name}`);
            return;
        }

        const created = addOrUpdateAccount({
            name: accountName || (uin ? String(uin) : '重登录账号'),
            code,
            platform: 'qq',
            qq: uin || '',
            uin: uin || '',
            avatar,
        });
        const newAcc = (created.accounts || [])[created.accounts.length - 1];
        if (newAcc) {
            if (startWorker) startWorker(newAcc);
            addAccountLog('add', `重登录成功，已新增账号: ${newAcc.name}`, newAcc.id, newAcc.name, { reason: 'relogin' });
            log('系统', `重登录成功，已新增账号并启动: ${newAcc.name}`, { accountId: String(newAcc.id), accountName: newAcc.name });
        }
    }

    function getTmpImagesDir(): string {
        const dir = path.join(getDataDir(), 'tmp');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    function getBaseUrl(): string {
        const cfg = typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : null;
        const configured = cfg && cfg.publicBaseUrl ? String(cfg.publicBaseUrl).trim() : '';
        if (configured) return configured.replace(/\/+$/, '');
        return `http://localhost:${adminPort || 3007}`;
    }

    async function generateWxReloginQr(): Promise<{ session: any; imageUrl: string; filePath: string } | null> {
        if (!wxLoginService) {
            log('错误', '微信登录服务未初始化，无法生成微信扫码二维码');
            return null;
        }
        try {
            const { session, qr } = await wxLoginService.createQrSession();
            const tmpDir = getTmpImagesDir();
            const fileName = `wx-qr-${Date.now()}.jpg`;
            const filePath = path.join(tmpDir, fileName);
            fs.writeFileSync(filePath, qr);
            const imageUrl = `${getBaseUrl()}/tmp-images/${fileName}`;
            return { session, imageUrl, filePath };
        } catch (e: any) {
            log('错误', `生成微信扫码二维码失败: ${e.message}`);
            return null;
        }
    }

    function startWxReloginWatcher({ session, accountId = '', accountName = '', qrFilePath = '' }: { session: any; accountId?: string; accountName?: string; qrFilePath?: string }): void {
        if (!session || !wxLoginService) return;

        const key = `wx:${accountId || 'unknown'}:${Date.now()}`;
        if (wxReloginWatchers.has(key)) return;
        wxReloginWatchers.set(key, { startedAt: Date.now() });
        log('系统', `已启动微信扫码重登录监听: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });

        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            wxReloginWatchers.delete(key);
            try { wxLoginService.destroy(session); } catch {}
            if (qrFilePath) {
                try { if (fs.existsSync(qrFilePath)) fs.unlinkSync(qrFilePath); } catch {}
            }
        };

        (async () => {
            const maxRounds = 120;
            for (let i = 0; i < maxRounds; i += 1) {
                try {
                    const status = await wxLoginService.poll(session);
                    if (status === 'waiting' || status === 'scanned') {
                        await sleep(1000);
                        continue;
                    }
                    if (status === 'authorized') {
                        await wxLoginService.confirm(session);
                        const code = await wxLoginService.issueCode(session, WX_LOGIN_APP_ID);
                        if (!code) {
                            log('错误', '微信扫码重登录失败: 未获取到新 code');
                            stop();
                            return;
                        }
                        log('系统', `微信扫码重登录成功: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || '') });
                        applyReloginCode({ accountId, accountName, authCode: code });
                        stop();
                        return;
                    }
                    if (status === 'cancelled' || status === 'expired') {
                        log('系统', `微信扫码二维码已${status === 'cancelled' ? '取消' : '过期'}: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || '') });
                        stop();
                        return;
                    }
                    await sleep(1000);
                } catch (e: any) {
                    log('错误', `微信扫码重登录监听异常: ${e.message}`);
                    await sleep(1000);
                }
            }
            log('系统', `微信扫码重登录监听超时: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || '') });
            stop();
        })();
    }

    function startReloginWatcher({ loginCode, accountId = '', accountName = '' }: { loginCode: string; accountId?: string; accountName?: string }): void {
        const code = String(loginCode || '').trim();
        if (!code) return;

        const key = `${accountId || 'unknown'}:${code}`;
        if (reloginWatchers.has(key)) return;
        reloginWatchers.set(key, { startedAt: Date.now() });
        log('系统', `已启动重登录监听: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });

        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            reloginWatchers.delete(key);
        };

        (async () => {
            const maxRounds = 120;
            for (let i = 0; i < maxRounds; i += 1) {
                try {
                    const status = await miniProgramLoginSession.queryStatus(code);
                    if (!status || status.status === 'Wait') {
                        await sleep(1000);
                        continue;
                    }
                    if (status.status === 'Used') {
                        log('系统', `重登录二维码已失效: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });
                        stop();
                        return;
                    }
                    if (status.status === 'OK') {
                        const ticket = String(status.ticket || '').trim();
                        const uin = String(status.uin || '').trim();
                        if (!ticket) {
                            log('错误', '重登录监听失败: ticket 为空');
                            stop();
                            return;
                        }
                        const authCode = await miniProgramLoginSession.getAuthCode(ticket, '1112386029');
                        if (!authCode) {
                            log('错误', '重登录监听失败: 未获取到新 code');
                            stop();
                            return;
                        }
                        applyReloginCode({ accountId, accountName, authCode, uin });
                        stop();
                        return;
                    }
                    await sleep(1000);
                } catch {
                    await sleep(1000);
                }
            }
            log('系统', `重登录监听超时: ${accountName || accountId || '未知账号'}`, { accountId: String(accountId || ''), accountName: accountName || '' });
            stop();
        })();
    }

    async function triggerOfflineReminder(payload: OfflineReminderPayload = {}): Promise<void> {
        try {
            const accountId = String(payload.accountId || '').trim();
            const accountName = String(payload.accountName || '').trim();
            const reason = String(payload.reason || 'unknown');

            log('系统', `触发下线提醒: 账号=${accountName || accountId}, 原因=${reason}`, {
                accountId,
                accountName,
                reason,
            });

            let username = '';
            let accountPlatform = String(payload.platform || '').trim();
            let accountQq = '';
            let accountUin = '';
            try {
                const data = getAccounts();
                const accounts = Array.isArray(data.accounts) ? data.accounts : [];
                const acc = accounts.find((a: any) => String(a.id) === accountId);
                if (acc) {
                    if (acc.username) username = String(acc.username).trim();
                    if (!accountPlatform) accountPlatform = String(acc.platform || 'qq').trim();
                    if (acc.qq) accountQq = String(acc.qq).trim();
                    if (acc.uin) accountUin = String(acc.uin).trim();
                }
            } catch (e: any) {
                log('错误', `查找账号用户名失败: ${e.message}`);
            }
            if (!accountPlatform) accountPlatform = 'qq';

            const cfg = store.getOfflineReminder ? store.getOfflineReminder(username) : null;
            if (!cfg) {
                log('错误', `未找到下线提醒配置: 用户=${username || '(空)'}`);
                return;
            }

            log('系统', `下线提醒配置: 渠道=${cfg.channel}, 标题=${cfg.title}`, {
                channel: cfg.channel,
                title: cfg.title,
                username,
            });

            const channelName = String(cfg.channel || '').trim().toLowerCase();
            const reloginUrlMode = String(cfg.reloginUrlMode || 'none').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const channel = channelName;
            const token = String(cfg.token || '').trim();
            const baseTitle = String(cfg.title || '').trim();
            const title = accountName ? `${baseTitle} ${accountName}` : baseTitle;
            let content = String(cfg.msg || '').trim();

            // 追加账号详细信息
            const platformLabel = accountPlatform === 'wx' ? '微信' : 'QQ';
            const qqOrUin = accountQq || accountUin;
            const infoLines = [
                `账号名称: ${accountName || '(未知)'}`,
                `登录平台: ${platformLabel}`,
            ];
            if (qqOrUin) infoLines.push(`QQ\u53f7: ${qqOrUin}`);
            const reasonText = reason.startsWith('kickout') ? '被踢下线'
                : reason.startsWith('offline_timeout') ? '持续离线'
                : reason.startsWith('disconnect') ? '连接断开'
                : reason;
            infoLines.push(`下线原因: ${reasonText}`);
            content = `${content}\n\n${infoLines.join('\n')}`;

            if (!channel || !token || !title || !content) {
                log('错误', `下线提醒配置不完整: channel=${channel}, token=${token ? '已设置' : '未设置'}, title=${title}, content=${content}`);
                return;
            }
            if (channel === 'webhook' && !endpoint) {
                log('错误', 'Webhook 渠道未设置接口地址');
                return;
            }
            if (reloginUrlMode === 'qq_link' || reloginUrlMode === 'qr_link') {
                try {
                    if (accountPlatform === 'wx') {
                        const wxResult = await generateWxReloginQr();
                        if (wxResult) {
                            content = `${content}\n\n请用微信扫描下方二维码完成重登录：\n![重登录二维码](${wxResult.imageUrl})\n\n注意：二维码有效期约 2 分钟`;
                            startWxReloginWatcher({
                                session: wxResult.session,
                                accountId: String(payload.accountId || '').trim(),
                                accountName: String(payload.accountName || '').trim(),
                                qrFilePath: wxResult.filePath,
                            });
                        } else {
                            content = `${content}\n\n微信扫码重登录暂不可用，请手动重新添加账号`;
                        }
                    } else {
                        const qr = await miniProgramLoginSession.requestLoginCode();
                        const loginCode = String((qr && qr.code) || '').trim();
                        const qqUrl = String((qr && (qr.url || qr.loginUrl)) || '').trim();
                        const qrCodeUrl = String((qr && qr.qrcode) || '').trim();
                        if (qqUrl) {
                            if (reloginUrlMode === 'qq_link') {
                                content = `${content}\n\n重登录链接: ${qqUrl}`;
                            } else {
                                const qrcodeText = qrCodeUrl || qqUrl;
                                content = `${content}\n\n重登录二维码链接: ${qrcodeText}`;
                            }
                        }
                        if (loginCode) {
                            startReloginWatcher({
                                loginCode,
                                accountId: String(payload.accountId || '').trim(),
                                accountName: String(payload.accountName || '').trim(),
                            });
                        }
                    }
                } catch (e: any) {
                    log('错误', `获取重登录链接失败: ${e.message}`);
                }
            }

            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                title,
                content,
            });

            if (ret && ret.ok) {
                const accName = String(payload.accountName || payload.accountId || '');
                log('系统', `下线提醒发送成功: ${accName}`);
            } else {
                log('错误', `下线提醒发送失败: ${ret && ret.msg ? ret.msg : 'unknown'}`);
            }
        } catch (e: any) {
            log('错误', `下线提醒发送异常: ${e.message}`);
        }
    }

    return {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        startReloginWatcher,
        startWxReloginWatcher,
        applyReloginCode,
    };
}

module.exports = {
    createReloginReminderService,
};
