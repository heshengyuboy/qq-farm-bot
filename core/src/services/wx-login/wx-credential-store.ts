/**
 * 微信登录凭据持久化存储
 *
 * 存储每个账号的 login_buffer、refresh_token、access_token、openid，
 * 用于后续自动重登录（无需重新扫码）。
 */
import type { AccountsData } from '../../types/account';

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');

const CREDENTIALS_FILE: string = getDataFile('wx-credentials.json');

export interface WxCredentials {
    accountId: string;
    openid: string;
    loginBuffer: string;
    accessToken: string;
    refreshToken: string;
    updatedAt: number;
}

function loadCredentials(): Record<string, WxCredentials> {
    ensureDataDir();
    const data = readJsonFile(CREDENTIALS_FILE, () => ({}));
    if (!data || typeof data !== 'object') return {};
    const result: Record<string, WxCredentials> = {};
    for (const [id, cred] of Object.entries(data as Record<string, any>)) {
        if (!id || !cred || typeof cred !== 'object') continue;
        if (typeof cred.loginBuffer !== 'string' || !cred.loginBuffer) continue;
        result[id] = {
            accountId: String(cred.accountId || id),
            openid: String(cred.openid || ''),
            loginBuffer: String(cred.loginBuffer),
            accessToken: String(cred.accessToken || ''),
            refreshToken: String(cred.refreshToken || ''),
            updatedAt: Number(cred.updatedAt) || 0,
        };
    }
    return result;
}

function saveCredentials(data: Record<string, WxCredentials>): void {
    ensureDataDir();
    writeJsonFileAtomic(CREDENTIALS_FILE, data);
}

function getCredentials(accountId: string): WxCredentials | null {
    if (!accountId) return null;
    const data = loadCredentials();
    return data[accountId] || null;
}

function setCredentials(accountId: string, cred: Partial<WxCredentials>): WxCredentials | null {
    if (!accountId) return null;
    const data = loadCredentials();
    const existing = data[accountId] || { accountId, openid: '', loginBuffer: '', accessToken: '', refreshToken: '', updatedAt: 0 };
    const updated: WxCredentials = {
        accountId,
        openid: cred.openid !== undefined ? String(cred.openid || '') : existing.openid,
        loginBuffer: cred.loginBuffer !== undefined ? String(cred.loginBuffer || '') : existing.loginBuffer,
        accessToken: cred.accessToken !== undefined ? String(cred.accessToken || '') : existing.accessToken,
        refreshToken: cred.refreshToken !== undefined ? String(cred.refreshToken || '') : existing.refreshToken,
        updatedAt: Date.now(),
    };
    if (!updated.loginBuffer) {
        // login_buffer 是核心凭据，如果为空则删除
        delete data[accountId];
    } else {
        data[accountId] = updated;
    }
    saveCredentials(data);
    return data[accountId] || null;
}

function deleteCredentials(accountId: string): void {
    if (!accountId) return;
    const data = loadCredentials();
    delete data[accountId];
    saveCredentials(data);
}

function getAllCredentials(): Record<string, WxCredentials> {
    return loadCredentials();
}

module.exports = {
    getCredentials,
    setCredentials,
    deleteCredentials,
    getAllCredentials,
};
