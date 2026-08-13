/**
 * 微信账号自动重登录服务
 *
 * 当微信账号掉线时，使用持久化的 login_buffer 自动获取新的登录 code，
 * 无需用户重新扫码。如果 login_buffer 过期，尝试用 refresh_token 刷新。
 */

const WX_LOGIN_APP_ID = 'wx5306c5978fdb76e4';

interface AutoReloginOptions {
    getCredentials: (accountId: string) => any;
    setCredentials: (accountId: string, cred: any) => any;
    addOrUpdateAccount: (acc: any) => any;
    getAccounts: () => any;
    restartWorker: (account: any) => void;
    log: (tag: string, msg: string, extra?: any) => void;
    addAccountLog: (action: string, msg: string, accountId?: string, accountName?: string, extra?: any) => void;
}

// 防止同一账号并发重登录
const pendingRelogin = new Map<string, Promise<AutoReloginResult>>();

export interface AutoReloginResult {
    ok: boolean;
    code?: string;
    refreshed?: boolean;
    reason?: string;
}

function createWxAutoReloginService(options: AutoReloginOptions) {
    const {
        getCredentials,
        setCredentials,
        addOrUpdateAccount,
        getAccounts,
        restartWorker,
        log,
        addAccountLog,
    } = options;

    async function tryAutoRelogin(accountId: string): Promise<AutoReloginResult> {
        // 防止并发
        if (pendingRelogin.has(accountId)) {
            return pendingRelogin.get(accountId)!;
        }

        const promise = _doAutoRelogin(accountId);
        pendingRelogin.set(accountId, promise);
        try {
            return await promise;
        } finally {
            pendingRelogin.delete(accountId);
        }
    }

    async function _doAutoRelogin(accountId: string): Promise<AutoReloginResult> {
        const cred = getCredentials(accountId);
        if (!cred || !cred.loginBuffer) {
            return { ok: false, reason: 'no_credentials' };
        }

        // 查找账号信息
        const data = getAccounts();
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        const account = accounts.find((a: any) => String(a.id) === String(accountId));
        if (!account) {
            return { ok: false, reason: 'account_not_found' };
        }
        if (String(account.platform || '').toLowerCase() !== 'wx') {
            return { ok: false, reason: 'not_wx_platform' };
        }

        const accountName = account.name || accountId;
        log('系统', `尝试微信自动重登录: ${accountName}`, { accountId, accountName });

        try {
            const { WxLoginService } = require('../services/wx-login/service');
            const wxLogin = new WxLoginService();

            const result = await wxLogin.getCodeFromCredentials(
                cred.loginBuffer,
                WX_LOGIN_APP_ID,
                cred.openid || '',
                cred.refreshToken || '',
            );

            if (!result.code) {
                log('错误', `微信自动重登录失败: 未获取到 code: ${accountName}`, { accountId, accountName });
                return { ok: false, reason: 'no_code_returned' };
            }

            // 更新账号的 code
            addOrUpdateAccount({
                id: accountId,
                code: result.code,
            });

            // 如果凭据被刷新了，更新持久化存储
            if (result.refreshed && result.newLoginBuffer) {
                setCredentials(accountId, {
                    loginBuffer: result.newLoginBuffer,
                    accessToken: result.newAccessToken || '',
                    refreshToken: result.newRefreshToken || '',
                    openid: cred.openid,
                });
                log('系统', `微信凭据已刷新: ${accountName}`, { accountId, accountName });
            }

            log('系统', `微信自动重登录成功: ${accountName}${result.refreshed ? ' (凭据已刷新)' : ''}`, { accountId, accountName });
            addAccountLog('auto_relogin', `微信自动重登录成功: ${accountName}`, accountId, accountName, { refreshed: !!result.refreshed });

            // 重启 worker
            const updatedAccount = { ...account, code: result.code };
            restartWorker(updatedAccount);

            return { ok: true, code: result.code, refreshed: result.refreshed };
        } catch (e: any) {
            const reason = e.message || 'unknown_error';
            log('错误', `微信自动重登录失败: ${accountName} - ${reason}`, { accountId, accountName });
            return { ok: false, reason };
        }
    }

    return { tryAutoRelogin };
}

module.exports = { createWxAutoReloginService };
