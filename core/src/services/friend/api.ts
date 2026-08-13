/**
 * 好友 API 底层操作 (protobuf 发送/接收)
 */

const { CONFIG } = require('../../config/config');
const { sendMsgAsync, getUserState, GatewayError } = require('../../utils/network');
const { types } = require('../../utils/proto');
const { toLong, toNum, log, logWarn, sleep, randomDelay } = require('../../utils/utils');
const {
    syncKnownFriendGidsFromRecentVisitors,
    fetchQqFriendsByKnownGids,
    syncKnownFriendGidsFromFriends,
    getEffectiveKnownQqFriendGids,
    fetchQqFriendsByLegacyMethod,
    dedupeFriendsByGid,
    buildFriendReply,
} = require('./gid-manager');

// 延迟引用 scheduler 模块，避免循环依赖
let _scheduler: any = null;
function schedulerRef(): any {
    if (!_scheduler) _scheduler = require('./scheduler');
    return _scheduler;
}

// ============ 好友 API ============
export async function getAllFriends(forceSync: boolean = false): Promise<any> {
    const isQQ: boolean = CONFIG.platform === 'qq';
    if (isQQ) {
        await syncKnownFriendGidsFromRecentVisitors(forceSync);
        const friendsFromKnownGids: any[] = await fetchQqFriendsByKnownGids();
        if (friendsFromKnownGids.length > 0) {
            syncKnownFriendGidsFromFriends(friendsFromKnownGids);
            return buildFriendReply(friendsFromKnownGids);
        }

        try {
            const legacyFriends: any[] = dedupeFriendsByGid(await fetchQqFriendsByLegacyMethod());
            if (legacyFriends.length > 0) {
                syncKnownFriendGidsFromFriends(legacyFriends);
            } else if (getEffectiveKnownQqFriendGids().length === 0) {
                logWarn('好友', 'QQ 好友列表为空；若近期接口已切到 GetGameFriends，请先在好友页维护已知好友 GID 列表', {
                    module: 'friend',
                    event: '好友列表接口',
                    result: 'empty',
                });
            }
            return buildFriendReply(legacyFriends);
        } catch (e: any) {
            if (getEffectiveKnownQqFriendGids().length === 0) {
                throw new Error(`QQ 好友列表获取失败，请先在好友页维护已知好友 GID 列表。${e.message}`);
            }
            throw e;
        }
    }

    const body: Uint8Array = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
    return types.GetAllFriendsReply.decode(replyBody);
}

export async function acceptFriends(gids: number[]): Promise<any> {
    const body: Uint8Array = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
        friend_gids: gids.map((g: number) => toLong(g)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
    return types.AcceptFriendsReply.decode(replyBody);
}

export async function getApplications(): Promise<any> {
    const body: Uint8Array = types.GetApplicationsRequest.encode(types.GetApplicationsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetApplications', body);
    return types.GetApplicationsReply.decode(replyBody);
}

export async function enterFriendFarm(friendGid: number): Promise<any> {
    const body: Uint8Array = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    return types.VisitEnterReply.decode(replyBody);
}

export async function leaveFriendFarm(friendGid: number): Promise<void> {
    const body: Uint8Array = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    try {
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body);
    } catch { /* 离开失败不影响主流程 */ }
}

export async function helpWater(friendGid: number, landIds: number[], stopWhenExpLimit: boolean = false): Promise<any> {
    const beforeExp: number = toNum((getUserState() || {}).exp);
    const body: Uint8Array = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    const reply: any = types.WaterLandReply.decode(replyBody);
    schedulerRef().updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp: number = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) schedulerRef().autoDisableHelpByExpLimit();
    }
    return reply;
}

export interface HelpFarmingOutcome {
    effect: 'confirmed' | 'noop' | 'uncertain';
    operationCount: number;
    landCount: number;
    landIds: number[];
    operationLimits: any[];
    code?: number;
    raw?: any;
}

export async function helpFarming(friendGid: number, landIds: number[], stopWhenExpLimit: boolean = false): Promise<HelpFarmingOutcome> {
    const targetIds: number[] = [...new Set<number>((landIds || []).map((id: any) => toNum(id)).filter((id: number) => id > 0))];
    if (targetIds.length === 0) {
        return { effect: 'noop', operationCount: 0, landCount: 0, landIds: [], operationLimits: [] };
    }

    const beforeExp: number = toNum((getUserState() || {}).exp);
    const body: Uint8Array = types.FarmingRequest.encode(types.FarmingRequest.create({
        land_ids: targetIds,
        host_gid: toLong(friendGid),
        field_3: 0,
        field_4: 2,
    })).finish();

    try {
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Farming', body, {
            expectedErrorCodes: [1001057],
        });
        const reply: any = types.FarmingReply.decode(replyBody);
        const results: any[] = Array.isArray(reply.results) ? reply.results : [];
        const confirmedLandIds: number[] = [...new Set(results.map((result: any) => toNum(result && result.land_id)).filter((id: number) => id > 0))];
        const operationLimits: any[] = Array.isArray(reply.operation_limits) ? reply.operation_limits : [];
        schedulerRef().updateOperationLimits(operationLimits);
        if (stopWhenExpLimit && results.length > 0) {
            await sleep(200);
            const afterExp: number = toNum((getUserState() || {}).exp);
            if (afterExp <= beforeExp) schedulerRef().autoDisableHelpByExpLimit();
        }
        return {
            effect: results.length > 0 ? 'confirmed' : 'uncertain',
            operationCount: results.length,
            landCount: confirmedLandIds.length,
            landIds: confirmedLandIds,
            operationLimits,
            raw: reply,
        };
    } catch (e: any) {
        if (e instanceof GatewayError && e.code === 1001057) {
            return {
                effect: 'noop',
                operationCount: 0,
                landCount: 0,
                landIds: [],
                operationLimits: [],
                code: e.code,
            };
        }
        throw e;
    }
}

export async function stealHarvest(friendGid: number, landIds: number[]): Promise<any> {
    const body: Uint8Array = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    const reply: any = types.HarvestReply.decode(replyBody);
    schedulerRef().updateOperationLimits(reply.operation_limits);
    return reply;
}

export async function putPlantItems(friendGid: number, landIds: number[], RequestType: any, ReplyType: any, method: string): Promise<number> {
    const result = await putPlantItemsDetailed(friendGid, landIds, RequestType, ReplyType, method);
    if (result.failed.length > 0 && !result.limitReached) {
        log('好友', `放虫/放草部分失败: ${result.failed[0].reason}`, {
            module: 'friend',
            event: '放虫放草失败',
            method,
            failedCount: result.failed.length,
        });
    }
    return result.ok;
}

export async function putPlantItemsDetailed(friendGid: number, landIds: number[], RequestType: any, ReplyType: any, method: string): Promise<{ ok: number; failed: any[]; limitReached?: boolean }> {
    const ids: number[] = [...new Set<number>((Array.isArray(landIds) ? landIds : [])
        .map((id: any) => toNum(id))
        .filter((id: number) => id > 0))];
    if (ids.length === 0) return { ok: 0, failed: [] };
    if (schedulerRef().isBadOperationLimitReached()) {
        return {
            ok: 0,
            limitReached: true,
            failed: ids.map((id: number) => ({ landId: id, reason: '今日放虫/放草次数已达上限' })),
        };
    }

    let ok: number = 0;
    const failed: any[] = [];
    for (let index: number = 0; index < ids.length; index++) {
        const landId: number = ids[index];
        if (schedulerRef().isBadOperationLimitReached() || schedulerRef().getRemainingBadOperationTimes() <= 0) {
            schedulerRef().markBadOperationLimitReached('operation_limit');
            failed.push(...ids.slice(index).map((id: number) => ({ landId: id, reason: '今日放虫/放草次数已达上限' })));
            break;
        }

        try {
            // The game client sends one PutWeeds/PutInsects request per land.
            const body: Uint8Array = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body, {
                expectedErrorCodes: [1001046],
            });
            const reply: any = ReplyType.decode(replyBody);
            schedulerRef().updateOperationLimits(reply.operation_limits);
            const confirmed: boolean = (Array.isArray(reply.land) ? reply.land : [])
                .some((land: any) => toNum(land && land.id) === landId);
            if (confirmed) ok++;
            else failed.push({ landId, reason: '服务端未确认土地状态变化' });
        } catch (e: any) {
            const limitReached: boolean = e instanceof GatewayError && e.code === 1001046;
            if (limitReached) {
                schedulerRef().markBadOperationLimitReached(method);
                failed.push(...ids.slice(index).map((id: number) => ({ landId: id, reason: '今日放虫/放草次数已达上限' })));
                break;
            }
            failed.push({ landId, reason: e && e.message ? e.message : '未知错误' });
        }

        if (index < ids.length - 1 && !schedulerRef().isBadOperationLimitReached()) {
            await randomDelay(80, 160);
        }
    }

    const limitReached: boolean = schedulerRef().isBadOperationLimitReached();
    return { ok, failed, ...(limitReached ? { limitReached: true } : {}) };
}

export async function putInsects(friendGid: number, landIds: number[]): Promise<number> {
    return putPlantItems(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

export async function putWeeds(friendGid: number, landIds: number[]): Promise<number> {
    return putPlantItems(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

export async function putInsectsDetailed(friendGid: number, landIds: number[]): Promise<{ ok: number; failed: any[]; limitReached?: boolean }> {
    return putPlantItemsDetailed(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

export async function putWeedsDetailed(friendGid: number, landIds: number[]): Promise<{ ok: number; failed: any[]; limitReached?: boolean }> {
    return putPlantItemsDetailed(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

// 使用社交道具（如友谊果实）
export async function putSocialItem(friendGid: number, landId: number, itemId: number): Promise<any> {
    const body: Uint8Array = types.PutSocialItemRequest.encode(types.PutSocialItemRequest.create({
        host_gid: toLong(friendGid),
        land_id: toLong(landId),
        item_id: toLong(itemId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'PutSocialItem', body);
    return types.PutSocialItemReply.decode(replyBody);
}

