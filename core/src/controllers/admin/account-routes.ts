export {};
import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';

/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */

const store = require('../../models/store');
const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('../../config/runtime-paths');
const { addOrUpdateAccount, deleteAccount } = store;
const { findAccountByRef } = require('../../services/account-resolver');
const userStore = require('../../models/user-store');
const { bindWxCredentialsToAccount } = require('./wx-login-routes');
const { deleteCredentials: _deleteWxCredentials } = require('../../services/wx-login/wx-credential-store');

const {
    getAccId,
    checkAccountAccess,
    getAccessibleAccountIds,
    handleApiError,
    getAccountList,
    resolveAccId,
} = require('./middleware');

function mountAccountRoutes(app: Application, ctx: AdminContext): void {

    // API: 账号管理
    app.get('/api/accounts', (req: Request, res: Response) => {
        try {
            const currentUser = (req as any).currentUser;
            let data: any;

            if (currentUser) {
                // 管理员可以看到所有账号，普通用户只能看到自己的账号
                const allAccounts = ctx.provider.getAccounts();
                if (currentUser.role === 'admin') {
                    data = allAccounts;
                } else {
                    data = {
                        ...allAccounts,
                        accounts: allAccounts.accounts.filter((a: any) => a.username === currentUser.username)
                    };
                }
            } else {
                // 未登录用户返回空列表
                data = { accounts: [], nextId: 1 };
            }

            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 更新账号备注（兼容旧接口）
    app.post('/api/account/remark', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList(ctx);
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (ctx.provider && typeof ctx.provider.setRuntimeAccountName === 'function') {
                ctx.provider.setRuntimeAccountName(accountId, remark);
            }
            if (ctx.provider && ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('update', `更新账号备注: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/accounts', (req: Request, res: Response) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const currentUser = (req as any).currentUser;
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            const visibleAccounts = currentUser && currentUser.username
                ? getAccountList(ctx, currentUser.username)
                : [];
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account: any) => String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;

            // 检查权限：普通用户只能更新自己的账号
            if (isUpdate && currentUser && currentUser.role !== 'admin') {
                if (!checkAccountAccess(ctx, req as any, resolveAccId(ctx, updateRef))) {
                    return res.status(403).json({ ok: false, error: '无权访问此账号' });
                }
            }

            // 检查额度：新增账号时检查用户额度限制
            if (!isUpdate && currentUser && currentUser.role !== 'admin') {
                const userAccounts = getAccountList(ctx, currentUser.username);
                const currentCount = userAccounts.length;
                const accountLimit = currentUser.accountLimit || userStore.DEFAULT_ACCOUNT_LIMIT || 2;

                if (currentCount >= accountLimit) {
                    return res.status(403).json({
                        ok: false,
                        error: `账号数量已达上限（${accountLimit}个），请购买额度卡密增加额度`
                    });
                }
            }

            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef) : '';
            const payload = isUpdate ? { ...body, id: resolvedUpdateId || String(updateRef) } : body;
            let wasRunning = false;
            if (isUpdate && ctx.provider.isAccountRunning) {
                wasRunning = ctx.provider.isAccountRunning(payload.id);
            }

            // 检查是否仅修改了备注信息
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = ctx.provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find((a: any) => a.id === payload.id);
                if (oldAccount) {
                    // 检查 payload 中是否只包含 id 和 name 字段
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            // 如果是新增账号，自动关联当前用户
            if (!isUpdate && currentUser) {
                payload.username = currentUser.username;
            }

            const data = addOrUpdateAccount(payload);
            if (ctx.provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts[data.accounts.length - 1] || {}).id || '');
                const accountName = payload.name || '';
                ctx.provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isRemarkRelogin
                        ? `通过备注重新登录账号: ${accountName || accountId}`
                        : isUpdate ? `更新账号: ${accountName || accountId}` : `添加账号: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
                // 微信平台：将登录凭据关联到账号 ID，用于后续自动重登录
                if (String(payload.platform || '').toLowerCase() === 'wx' && payload.code) {
                    try { bindWxCredentialsToAccount(accountId, String(payload.code)); } catch {}
                }
            }
            // 如果是新增，自动启动
            if (!isUpdate) {
                const newAcc = data.accounts[data.accounts.length - 1];
                if (newAcc) ctx.provider.startAccount(newAcc.id);
            } else if (isRemarkRelogin) {
                // Adding with an existing remark is a relogin operation, including for stopped accounts.
                ctx.provider.restartAccount(payload.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 如果是更新，且之前在运行，且不是仅修改备注，则重启
                ctx.provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/accounts/:id', (req: Request, res: Response) => {
        try {
            const resolvedId = resolveAccId(ctx, req.params.id) || String(req.params.id || '');

            // 检查权限
            if (!checkAccountAccess(ctx, req as any, resolvedId)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            const before = ctx.provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);
            ctx.provider.stopAccount(resolvedId);
            // 删除微信凭据
            try { _deleteWxCredentials(resolvedId); } catch {}
            const data = deleteAccount(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `删除账号: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 账号日志
    app.get('/api/account-logs', (req: Request, res: Response) => {
        try {
            const limit = Number.parseInt(req.query.limit as string) || 100;
            const currentUser = (req as any).currentUser;

            let list: any[] = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 所有用户（包括管理员）只能看到自己账号的操作日志
            if (currentUser) {
                const accessibleIds = getAccessibleAccountIds(ctx, req as any);
                list = list.filter((log: any) => {
                    const logAccountId = log.accountId || log.id;
                    return accessibleIds.includes(logAccountId);
                });
            }

            // 与当前 web 前端保持一致：直接返回数组
            res.json(list);
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 日志
    app.get('/api/logs', (req: Request, res: Response) => {
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(ctx, queryAccountIdRaw)) : getAccId(ctx, req);
        const currentUser = (req as any).currentUser;

        // 必须登录才能查看日志
        if (!currentUser) {
            return res.status(401).json({ ok: false, error: '未登录' });
        }

        // 如果指定了账号ID，检查权限
        if (id && !checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        // 如果没有指定账号ID，获取当前用户可访问的所有账号的日志
        if (!id) {
            // 所有用户（包括管理员）只能获取自己可访问账号的日志
            const accessibleIds = getAccessibleAccountIds(ctx, req as any);
            const allLogs: any[] = [];
            const options = {
                limit: Number.parseInt(req.query.limit as string) || 100,
                tag: req.query.tag || '',
                module: req.query.module || '',
                event: req.query.event || '',
                keyword: req.query.keyword || '',
                isWarn: req.query.isWarn,
                timeFrom: req.query.timeFrom || '',
                timeTo: req.query.timeTo || '',
            };

            // 获取每个可访问账号的日志
            for (const accId of accessibleIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }

            // 按时间排序并限制数量
            allLogs.sort((a: any, b: any) => (b.time || 0) - (a.time || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 指定了账号ID且通过权限检查，返回该账号的日志
        const options = {
            limit: Number.parseInt(req.query.limit as string) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = ctx.provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 清空当前账号运行日志
    app.delete('/api/logs', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = ctx.provider.clearLogs(id);

            if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                const accountLogs = ctx.provider.getLogs(id, { limit: 100 });
                ctx.io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = ctx.provider.getLogs('', { limit: 100 });
                ctx.io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 设置页统一保存（单次写入；运行中账号等待 worker revision ACK）
    app.post('/api/settings/save', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        // 检查权限
        if (!checkAccountAccess(ctx, req as any, id)) {
            return res.status(403).json({ ok: false, error: '无权访问此账号' });
        }

        try {
            const data = await ctx.provider.saveSettings(id, req.body || {});
            const unconfirmed = data && data.status === 'unconfirmed';
            res.status(unconfirmed ? 202 : 200).json({
                ok: !unconfirmed,
                saved: !!(data && data.saved),
                stopped: !!(data && data.status === 'stopped'),
                confirmed: !!(data && data.confirmed),
                unconfirmed: !!unconfirmed,
                status: data?.status,
                code: unconfirmed ? data.confirmationError?.code : undefined,
                error: unconfirmed ? (data.confirmationError?.message || '配置已保存，但 worker 尚未确认应用') : undefined,
                data: data || {},
            });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 设置面板主题
    app.post('/api/settings/theme', async (req: Request, res: Response) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 保存下线提醒配置
    app.post('/api/settings/offline-reminder', async (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const currentUser = (req as any).currentUser;

            // 必须登录才能保存下线提醒配置
            if (!currentUser) {
                return res.status(401).json({ ok: false, error: '未登录' });
            }

            // 保存到用户隔离的配置中
            const data = store.setOfflineReminder
                ? store.setOfflineReminder(body, currentUser.username)
                : {};
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 测试下线提醒推送（不落盘）
    app.post('/api/settings/offline-reminder/test', async (req: Request, res: Response) => {
        try {
            const currentUser = (req as any).currentUser;
            const saved = store.getOfflineReminder && currentUser
                ? store.getOfflineReminder(currentUser.username)
                : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const titleBase = String(cfg.title || '账号下线提醒').trim();
            const msgBase = String(cfg.msg || '账号下线').trim();
            const testPlatform = String(cfg.testPlatform || 'qq').trim().toLowerCase();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '推送渠道不能为空' });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 渠道需要填写接口地址' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../../services/push');
            const testPlatformLabel = testPlatform === 'wx' ? '微信' : 'QQ';
            let testContent = `${msgBase}\n\n这是一条下线提醒测试消息。\n登录平台: ${testPlatformLabel}\n时间: ${ts}`;

            if (testPlatform === 'wx') {
                try {
                    const { WxLoginService } = require('../../services/wx-login/service');
                    const wxLogin = new WxLoginService();
                    const { session, qr } = await wxLogin.createQrSession();
                    const tmpDir = path.join(getDataDir(), 'tmp');
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                    const fileName = `wx-qr-test-${Date.now()}.jpg`;
                    const filePath = path.join(tmpDir, fileName);
                    fs.writeFileSync(filePath, qr);
                    const adminPort = Number(process.env.ADMIN_PORT) || 3007;
                    const { getRuntimeConfig: _getRc } = require('../../config/config');
                    const _rc = typeof _getRc === 'function' ? _getRc() : null;
                    const _baseUrl = (_rc && _rc.publicBaseUrl) ? String(_rc.publicBaseUrl).trim().replace(/\/+$/, '') : `http://localhost:${adminPort}`;
                    const imageUrl = `${_baseUrl}/tmp-images/${fileName}`;
                    testContent = `${msgBase}\n\n请用微信扫描下方二维码完成重登录：\n![重登录二维码](${imageUrl})\n\n注意：二维码有效期约 2 分钟\n时间: ${ts}`;
                    try { wxLogin.destroy(session); } catch {}
                } catch (e: any) {
                    testContent = `${msgBase}\n\n微信扫码重登录二维码生成失败: ${e.message}\n时间: ${ts}`;
                }
            } else {
                try {
                    const { MiniProgramLoginSession } = require('../../services/qrlogin');
                    const qrResult = await MiniProgramLoginSession.requestLoginCode();
                    const qqUrl = String((qrResult && (qrResult.url || qrResult.loginUrl)) || '').trim();
                    if (qqUrl) {
                        testContent = `${msgBase}\n\n重登录二维码链接: ${qqUrl}\n\n这是一条下线提醒测试消息。\n时间: ${ts}`;
                    }
                } catch (e: any) {
                    testContent = `${msgBase}\n\nQQ重登录二维码生成失败: ${e.message}\n时间: ${ts}`;
                }
            }

            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                title: `${titleBase}（测试）`,
                content: testContent,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '推送失败：无返回结果' });
            }

            const isSuccess = ret.ok ||
                ret.code === 'ok' ||
                ret.code === '0' ||
                String(ret.msg || '').includes('成功') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';

            if (!isSuccess && ret.msg && !String(ret.msg).includes('成功')) {
                return res.status(400).json({ ok: false, error: ret.msg || '推送失败', data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '推送成功' });
        } catch (e: any) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 获取配置
    app.get('/api/settings', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            const currentUser = (req as any).currentUser;

            // 检查权限（如果指定了账号ID）
            if (id && !checkAccountAccess(ctx, req as any, id)) {
                return res.status(403).json({ ok: false, error: '无权访问此账号' });
            }

            // 直接从主进程的 store 读取，确保即使账号未运行也能获取配置
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const bagSeedExcludeIds = id && (typeof store.getBagSeedExcludeIds === 'function') ? store.getBagSeedExcludeIds(id) : [];
            const primaryAccountId = id && (typeof store.getPrimaryAccountId === 'function') ? store.getPrimaryAccountId(id) : '';
            const ui = store.getUI();
            // 获取用户隔离的下线提醒配置
            const offlineReminder = store.getOfflineReminder && currentUser
                ? store.getOfflineReminder(currentUser.username)
                : { channel: 'webhook', reloginUrlMode: 'none', endpoint: '', token: '', title: '账号下线提醒', msg: '账号下线', offlineDeleteSec: 0 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedFallbackStrategy, bagSeedExcludeIds, primaryAccountId, ui, offlineReminder } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 获取默认配置
    app.get('/api/settings/default', (_req: Request, res: Response) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '无法获取默认配置' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
}

module.exports = { mountAccountRoutes };
