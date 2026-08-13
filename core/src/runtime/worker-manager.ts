export {};
const { createScheduler } = require('../services/scheduler');

interface WorkerManagerOptions {
    fork: any;
    WorkerThread: any;
    runtimeMode?: string;
    processRef: any;
    mainEntryPath: string;
    workerScriptPath: string;
    workers: Record<string, any>;
    globalLogs: any[];
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
    normalizeStatusForPanel: (data: any, accountId: string, accountName: string) => any;
    buildConfigSnapshotForAccount: (accountId: string) => any;
    getOfflineAutoDeleteMs: (username?: string) => number;
    triggerOfflineReminder: (payload: any) => void;
    wxAutoRelogin?: { tryAutoRelogin: (accountId: string) => Promise<{ ok: boolean; reason?: string }> };
    addOrUpdateAccount: (acc: any) => any;
    deleteAccount: (id: string) => void;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onWorkerLog?: (entry: any, accountId: string, accountName?: string) => void;
}

function createWorkerManager(options: WorkerManagerOptions) {
    const {
        fork,
        WorkerThread,
        runtimeMode = 'thread',
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        wxAutoRelogin,
        addOrUpdateAccount,
        deleteAccount,
        onStatusSync,
        onWorkerLog,
    } = options;
    const managerScheduler = createScheduler('worker_manager');
    const useThreadRuntime = runtimeMode === 'thread' && !(processRef as any).pkg && typeof WorkerThread === 'function';

    function createThreadWorker(account: any): any {
        const workerOptions: any = {
            workerData: {
                accountId: String(account.id || ''),
                channel: 'thread',
            },
        };
        // When running from source with tsx, configure worker to use tsx
        if (workerScriptPath.endsWith('.ts')) {
            workerOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        const worker = new WorkerThread(workerScriptPath, workerOptions);
        worker.send = (payload: any) => worker.postMessage(payload);
        worker.kill = () => worker.terminate();
        return worker;
    }

    function createForkWorker(account: any): any {
        if ((processRef as any).pkg) {
            return fork(mainEntryPath, [], {
                execPath: processRef.execPath,
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                env: { ...processRef.env, FARM_WORKER: '1', FARM_ACCOUNT_ID: String(account.id || '') },
            });
        }
        const forkOptions: any = {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            env: { ...processRef.env, FARM_ACCOUNT_ID: String(account.id || '') },
        };
        if (workerScriptPath.endsWith('.ts')) {
            forkOptions.execArgv = ['--require', 'tsx/cjs'];
        }
        return fork(workerScriptPath, [], forkOptions);
    }

    function createWorkerProcess(account: any): any {
        if (useThreadRuntime) return createThreadWorker(account);
        return createForkWorker(account);
    }

    function startWorker(account: any): boolean {
        if (!account || !account.id) return false;
        if (workers[account.id]) return false;

        log('系统', `正在启动账号: ${account.name}`, { accountId: String(account.id), accountName: account.name });

        let child: any = null;
        try {
            child = createWorkerProcess(account);
        } catch (err: any) {
            const reason = err && err.message ? err.message : String(err || 'unknown error');
            log('错误', `账号 ${account.name} 启动失败: ${reason}`, { accountId: String(account.id), accountName: account.name });
            addAccountLog('start_failed', `账号 ${account.name} 启动失败`, account.id, account.name, { reason });
            return false;
        }

        workers[account.id] = {
            process: child,
            status: null,
            logs: [],
            requests: new Map(),
            reqId: 1,
            name: account.name,
            username: account.username || '',
            platform: account.platform || 'qq',
            stopping: false,
            disconnectedSince: 0,
            autoDeleteTriggered: false,
            terminalHandled: false,
            wsError: null,
        };

        child.send({
            type: 'start',
            config: {
                code: account.code,
                platform: account.platform,
            },
        });
        child.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(account.id) });

        child.on('message', (msg: any) => {
            handleWorkerMessage(account.id, child, msg);
        });

        child.on('error', (err: any) => {
            log('系统', `账号 ${account.name} 子进程启动失败: ${err && err.message ? err.message : err}`, { accountId: String(account.id), accountName: account.name });
        });

        child.on('exit', (code: number, signal: string) => {
            const current = workers[account.id];
            if (!current || current.process !== child) return;
            const displayName = current.name || account.name;
            log('系统', `账号 ${displayName} 进程退出 (code=${code}, signal=${signal || 'none'})`, {
                accountId: String(account.id),
                accountName: displayName,
                runtimeMode: useThreadRuntime ? 'thread' : 'fork',
            });

            managerScheduler.clear(`force_kill_${account.id}`);
            managerScheduler.clear(`restart_fallback_${account.id}`);

            if (current && current.requests && current.requests.size > 0) {
                for (const [reqId, req] of current.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${account.id}_${reqId}`);
                    try {
                        req.reject(new Error('Worker exited'));
                    } catch {}
                }
                current.requests.clear();
            }

            if (current && current.process === child) {
                delete workers[account.id];
            }
        });
        return true;
    }

    function stopWorker(accountId: string): void {
        const worker = workers[accountId];
        if (!worker) return;

        const proc = worker.process;
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        managerScheduler.setTimeoutTask(`force_kill_${accountId}`, 1000, () => {
            const current = workers[accountId];
            if (current && current.process === proc) {
                current.process.kill();
                delete workers[accountId];
            }
        });
    }

    function restartWorker(account: any): void {
        if (!account) return;
        const accountId = account.id;
        const worker = workers[accountId];
        if (!worker) { startWorker(account); return; }
        const proc = worker.process;
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            managerScheduler.clear(`restart_fallback_${accountId}`);
            const current = workers[accountId];
            if (!current) { startWorker(account); return; }
            if (current.process !== proc) return;
            delete workers[accountId];
            startWorker(account);
        };
        const killIfStale = () => {
            const current = workers[accountId];
            if (!current || current.process !== proc) return false;
            try {
                current.process.kill();
            } catch {}
            delete workers[accountId];
            return true;
        };
        if (typeof proc.exitCode === 'number' || proc.signalCode) {
            startOnce();
            return;
        }
        proc.once('exit', startOnce);
        stopWorker(accountId);
        managerScheduler.setTimeoutTask(`restart_fallback_${accountId}`, 1500, () => {
            if (started) return;
            killIfStale();
            startOnce();
        });
    }

    function errorFromWorkerPayload(payload: any): Error & { code?: string | number } {
        if (!payload || typeof payload !== 'object') return new Error(String(payload || 'Worker API error'));
        const error: Error & { code?: string | number } = new Error(String(payload.message || 'Worker API error'));
        if (payload.name) error.name = String(payload.name);
        if (payload.code !== undefined && payload.code !== null && payload.code !== '') error.code = payload.code;
        return error;
    }

    async function handleWorkerMessage(accountId: string, sourceProcess: any, msg: any): Promise<void> {
        const worker = workers[accountId];
        if (!worker || worker.process !== sourceProcess) return;

        if (msg.type === 'status_sync') {
            worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
            if (typeof onStatusSync === 'function') {
                onStatusSync(accountId, worker.status, worker.name);
            }

            if (msg.data && msg.data.status && msg.data.status.name) {
                const newNick = String(msg.data.status.name).trim();
                if (newNick && newNick !== '未知' && newNick !== '未登录') {
                    if (worker.nick !== newNick) {
                        const oldNick = worker.nick;
                        worker.nick = newNick;
                        addOrUpdateAccount({
                            id: accountId,
                            nick: newNick,
                        });
                        if (oldNick !== newNick) {
                            log('系统', `已同步账号昵称: ${oldNick || 'None'} -> ${newNick}`, { accountId, accountName: worker.name });
                        }
                    }
                }
            }

            const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
            if (connected) {
                worker.disconnectedSince = 0;
                worker.autoDeleteTriggered = false;
                worker.wsError = null;
            } else if (!worker.stopping) {
                const now = Date.now();
                if (!worker.disconnectedSince) worker.disconnectedSince = now;
                const offlineMs = now - worker.disconnectedSince;
                const autoDeleteMs = getOfflineAutoDeleteMs(worker.username);
                if (!worker.autoDeleteTriggered && offlineMs >= autoDeleteMs) {
                    const offlineMin = Math.floor(offlineMs / 60000);

                    // 微信账号：先尝试自动重登录，成功则跳过删除
                    if (worker.platform === 'wx' && wxAutoRelogin) {
                        try {
                            log('系统', `账号 ${worker.name} 离线 ${offlineMin} 分钟，尝试微信自动重登录...`, { accountId, accountName: worker.name });
                            const reloginResult = await wxAutoRelogin.tryAutoRelogin(accountId);
                            if (reloginResult.ok) {
                                log('系统', `账号 ${worker.name} 微信自动重登录成功，恢复连接`, { accountId, accountName: worker.name });
                                worker.disconnectedSince = 0;
                                worker.autoDeleteTriggered = false;
                                worker.wsError = null;
                                return; // 跳过后续的删除流程
                            }
                            log('系统', `账号 ${worker.name} 微信自动重登录失败: ${reloginResult.reason}`, { accountId, accountName: worker.name });
                        } catch (e: any) {
                            log('错误', `账号 ${worker.name} 微信自动重登录异常: ${e.message}`, { accountId, accountName: worker.name });
                        }
                    }

                    worker.autoDeleteTriggered = true;
                    log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                    triggerOfflineReminder({
                        accountId,
                        accountName: worker.name,
                        username: worker.username,
                        reason: 'offline_timeout',
                        offlineMs,
                        platform: worker.platform,
                    });
                    addAccountLog(
                        'offline_delete',
                        `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                        accountId,
                        worker.name,
                        { reason: 'offline_timeout', offlineMs },
                    );
                    stopWorker(accountId);
                    try {
                        deleteAccount(accountId);
                    } catch (e: any) {
                        log('错误', `删除离线账号失败: ${e.message}`);
                    }
                }
            }
        } else if (msg.type === 'log') {
            const logEntry = {
                ...msg.data,
                accountId,
                accountName: worker.name,
                ts: Date.now(),
                meta: msg.data && msg.data.meta ? msg.data.meta : {},
            };
            logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
            worker.logs.push(logEntry);
            if (worker.logs.length > 1000) worker.logs.shift();
            globalLogs.push(logEntry);
            if (globalLogs.length > 1000) globalLogs.shift();
            if (typeof onWorkerLog === 'function') {
                onWorkerLog(logEntry, accountId, worker.name);
            }
        } else if (msg.type === 'error') {
            const workerError = errorFromWorkerPayload(msg.error);
            log('错误', `账号[${accountId}]进程报错: ${workerError.message}`, {
                accountId: String(accountId),
                accountName: worker.name,
                errorCode: workerError.code,
                errorName: workerError.name,
            });
        } else if (msg.type === 'ws_error') {
            const code = Number(msg.code) || 0;
            const message = msg.message || '';
            worker.wsError = { code, message, at: Date.now() };
            if (code === 400) {
                addAccountLog(
                    'ws_400',
                    `账号 ${worker.name} 登录失效，请更新 Code`,
                    accountId,
                    worker.name,
                );
            }
        } else if (msg.type === 'account_kicked') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const reason = msg.reason || '未知';
            log('系统', `账号 ${worker.name} 被踢下线，已自动停止账号`, { accountId: String(accountId), accountName: worker.name });
            triggerOfflineReminder({
                accountId,
                accountName: worker.name,
                reason: `kickout:${reason}`,
                offlineMs: 0,
                platform: worker.platform,
            });
            addAccountLog('kickout_stop', `账号 ${worker.name} 被踢下线，已自动停止`, accountId, worker.name, { reason });
            stopWorker(accountId);
        } else if (msg.type === 'account_disconnected') {
            if (worker.terminalHandled) return;
            worker.terminalHandled = true;
            const source = String(msg.source || 'ws_close');
            const code = Number(msg.code) || 0;
            const reason = String(msg.reason || '连接已断开');
            const phase = String(msg.phase || 'unknown');
            if (worker.status?.connection) worker.status.connection.connected = false;
            if (worker.requests.size > 0) {
                for (const [reqId, req] of worker.requests.entries()) {
                    managerScheduler.clear(`api_timeout_${accountId}_${reqId}`);
                    try { req.reject(new Error('账号连接已断开')); } catch {}
                }
                worker.requests.clear();
            }
            log('系统', `账号 ${worker.name} 连接已断开 (source=${source}, code=${code}, phase=${phase})`, {
                accountId: String(accountId),
                accountName: worker.name,
                source,
                code,
                phase,
            });

            // 微信账号：立即尝试自动重登录（无需等待离线超时）
            if (worker.platform === 'wx' && wxAutoRelogin) {
                const wxAccount = { ...worker, id: accountId, name: worker.name };
                stopWorker(accountId);

                const tryWxRelogin = async (attempt: number, maxAttempts: number) => {
                    try {
                        log('系统', `账号 ${worker.name} 微信自动重登录尝试 ${attempt}/${maxAttempts}...`, { accountId, accountName: worker.name, attempt });
                        const reloginResult = await wxAutoRelogin.tryAutoRelogin(accountId);
                        if (reloginResult.ok) {
                            log('系统', `账号 ${worker.name} 微信自动重登录成功 (尝试 ${attempt}/${maxAttempts})`, { accountId, accountName: worker.name });
                            return;
                        }
                        log('系统', `账号 ${worker.name} 微信自动重登录失败: ${reloginResult.reason} (${attempt}/${maxAttempts})`, { accountId, accountName: worker.name });
                    } catch (e: any) {
                        log('错误', `账号 ${worker.name} 微信自动重登录异常: ${e.message} (${attempt}/${maxAttempts})`, { accountId, accountName: worker.name });
                    }

                    if (attempt < maxAttempts) {
                        // 失败后延迟重试：第1次等30秒，第2次等60秒，第3次等120秒
                        const delaySec = 30 * Math.pow(2, attempt - 1);
                        log('系统', `账号 ${worker.name} ${delaySec}秒后进行第 ${attempt + 1} 次重登录尝试...`, { accountId, accountName: worker.name });
                        managerScheduler.setTimeoutTask(`wx_relogin_retry_${accountId}`, delaySec * 1000, () => {
                            tryWxRelogin(attempt + 1, maxAttempts);
                        });
                    } else {
                        // 所有重登录尝试均失败，回退到手动扫码
                        log('系统', `账号 ${worker.name} 微信自动重登录全部失败 (${maxAttempts} 次)，需要重新扫码登录`, { accountId, accountName: worker.name });
                        triggerOfflineReminder({
                            accountId,
                            accountName: worker.name,
                            username: worker.username,
                            reason: `disconnect:${source}:${phase}:${code}`,
                            offlineMs: 0,
                            platform: worker.platform,
                        });
                        addAccountLog(
                            'disconnect_stop',
                            `账号 ${worker.name} 连接断开且自动重登录失败，需要重新扫码`,
                            accountId,
                            worker.name,
                            { source, code, reason, phase },
                        );
                    }
                };

                // 首次重登录尝试（断开后立即执行）
                tryWxRelogin(1, 4);
            } else {
                // 非微信账号：保持原有逻辑
                log('系统', `账号 ${worker.name} 连接已断开，已停止运行并等待重新扫码`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                });
                triggerOfflineReminder({
                    accountId,
                    accountName: worker.name,
                    username: worker.username,
                    reason: `disconnect:${source}:${phase}:${code}`,
                    offlineMs: 0,
                    platform: worker.platform,
                });
                addAccountLog(
                    'disconnect_stop',
                    `账号 ${worker.name} 连接已断开，已停止运行并等待重新扫码`,
                    accountId,
                    worker.name,
                    { source, code, reason, phase, connectionId: Number(msg.connectionId) || 0 },
                );
                stopWorker(accountId);
            }
        } else if (msg.type === 'api_response') {
            const { id, result, error } = msg;
            managerScheduler.clear(`api_timeout_${accountId}_${id}`);
            const req = worker.requests.get(id);
            if (req) {
                if (error) req.reject(errorFromWorkerPayload(error));
                else req.resolve(result);
                worker.requests.delete(id);
            }
        } else if (msg.type === 'friend_blacklist_add') {
            const gid = Number(msg.gid) || 0;
            if (gid > 0) {
                const { addFriendToBlacklist: addToBlacklist } = require('../models/store');
                addToBlacklist(accountId, gid);
                log('好友', `已将好友 ${msg.friendName || `GID:${gid}`} 加入黑名单`, {
                    accountId: String(accountId),
                    accountName: worker.name,
                    friendGid: gid,
                    friendName: msg.friendName,
                    reason: msg.reason,
                });
                const worker_process = workers[accountId];
                if (worker_process && worker_process.process) {
                    worker_process.process.send({ type: 'config_sync', config: buildConfigSnapshotForAccount(accountId) });
                }
            }
        } else if (msg.type === 'cross_account_steal_request') {
            // 次级账号请求主账号偷菜
            const secondaryAccountId = String(msg.accountId || accountId);
            const secondaryGid = Number(msg.gid) || 0;
            const secondaryName = String(msg.accountName || worker.name || '');
            const { getPrimaryAccountId: _getPrimaryAccId } = require('../models/store');
            const primaryAccountId = typeof _getPrimaryAccId === 'function' ? _getPrimaryAccId(secondaryAccountId) : '';

            const sendResponseToSecondary = (payload: any) => {
                const secondaryWorker = workers[secondaryAccountId];
                if (secondaryWorker && secondaryWorker.process) {
                    secondaryWorker.process.send({ type: 'cross_account_steal_response', ...payload });
                }
            };

            if (!primaryAccountId) {
                sendResponseToSecondary({ ok: false, reason: 'no_primary', stolen: 0 });
                return;
            }

            const primaryWorker = workers[primaryAccountId];
            if (!primaryWorker || primaryWorker.stopping || primaryWorker.terminalHandled) {
                log('跨账号偷菜', `主账号 ${primaryAccountId} 未运行，跳过偷`, {
                    module: 'cross_steal', event: '跨账号偷菜', result: 'primary_offline',
                    secondaryAccountId, secondaryGid, primaryAccountId,
                });
                sendResponseToSecondary({ ok: false, reason: 'primary_offline', stolen: 0 });
                return;
            }

            if (!secondaryGid) {
                sendResponseToSecondary({ ok: false, reason: 'invalid_gid', stolen: 0 });
                return;
            }

            log('跨账号偷菜', `通知主账号 ${primaryAccountId} 偷取 ${secondaryName}(${secondaryAccountId}) 的作物`, {
                module: 'cross_steal', event: '跨账号偷菜', result: 'request_sent',
                secondaryAccountId, secondaryGid, primaryAccountId,
            });

            callWorkerApi(primaryAccountId, 'stealFromAccount', secondaryGid, secondaryName)
                .then((result: any) => {
                    const stolen = Number(result && result.stolen) || 0;
                    log('跨账号偷菜', `主账号偷取 ${secondaryName} 完成，偷取 ${stolen} 块`, {
                        module: 'cross_steal', event: '跨账号偷菜', result: 'ok',
                        secondaryAccountId, secondaryGid, primaryAccountId, stolen,
                    });
                    sendResponseToSecondary({ ok: true, stolen, reason: '' });
                })
                .catch((e: any) => {
                    log('跨账号偷菜', `主账号偷取 ${secondaryName} 失败: ${e.message}`, {
                        module: 'cross_steal', event: '跨账号偷菜', result: 'error',
                        secondaryAccountId, secondaryGid, primaryAccountId, error: e.message,
                    });
                    sendResponseToSecondary({ ok: false, reason: e.message || 'steal_failed', stolen: 0 });
                });
        }
    }

    function callWorkerApi(accountId: string, method: string, ...args: any[]): Promise<any> {
        const worker = workers[accountId];
        if (!worker) return Promise.reject(new Error('账号未运行'));
        if (worker.stopping || worker.terminalHandled) return Promise.reject(new Error('账号已离线'));

        return new Promise((resolve, reject) => {
            const id = worker.reqId++;
            worker.requests.set(id, { resolve, reject });

            managerScheduler.setTimeoutTask(`api_timeout_${accountId}_${id}`, 10000, () => {
                if (worker.requests.has(id)) {
                    worker.requests.delete(id);
                    reject(new Error('API Timeout'));
                }
            });

            worker.process.send({ type: 'api_call', id, method, args });
        });
    }

    return {
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
    };
}

module.exports = {
    createWorkerManager,
};
