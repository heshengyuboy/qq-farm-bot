/*
 * Decode selected websocket captures and retain unknown protobuf fields.
 * Usage: pnpm -C core exec node ../tools/decode-latest-protocols.js <capture-dir>
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const coreRequire = createRequire(path.resolve(__dirname, '../core/package.json'));
const protobuf = coreRequire('protobufjs');
const cryptoWasm = require('../core/dist/utils/crypto-wasm');

const captureDir = path.resolve(process.argv[2] || 'C:/Users/liyp/Downloads/协议');
const protoDir = path.resolve(__dirname, '../core/src/proto');
const protoFiles = fs.readdirSync(protoDir)
    .filter((name) => name.endsWith('.proto'))
    .map((name) => path.join(protoDir, name));

const selected = new Set([
    'gamepb.activitypb.ActivityService.Operate',
    'gamepb.itempb.ItemService.Bag',
    'gamepb.itempb.ItemService.Use',
    'gamepb.itempb.ItemService.BatchUse',
    'gamepb.taskpb.TaskService.TaskInfo',
    'gamepb.taskpb.TaskService.ClaimTaskReward',
    'gamepb.seasonpb.SeasonService.GetSeasonInfo',
]);

function scalar(value) {
    return typeof value === 'bigint' ? value.toString() : value;
}

function printableText(buffer) {
    const text = buffer.toString('utf8');
    if (!text || text.includes('\uFFFD')) return null;
    const printable = Array.from(text).filter((char) => /[\p{L}\p{N}\p{P}\p{S}\s]/u.test(char)).length;
    return printable / Array.from(text).length > 0.9 ? text : null;
}

function rawFields(buffer, depth = 0) {
    if (depth > 6) return { hex: buffer.toString('hex') };
    const reader = protobuf.Reader.create(buffer);
    const fields = [];
    try {
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const field = tag >>> 3;
            const wire = tag & 7;
            if (field <= 0) throw new Error('invalid field');
            if (wire === 0) {
                fields.push({ field, wire, value: scalar(reader.uint64()) });
            } else if (wire === 1) {
                fields.push({ field, wire, value: reader.fixed64().toString() });
            } else if (wire === 2) {
                const value = Buffer.from(reader.bytes());
                const entry = { field, wire, hex: value.toString('hex') };
                const text = printableText(value);
                if (text !== null) entry.text = text;
                try {
                    const nested = rawFields(value, depth + 1);
                    if (nested.fields && nested.fields.length) entry.nested = nested.fields;
                } catch {}
                fields.push(entry);
            } else if (wire === 5) {
                fields.push({ field, wire, value: reader.fixed32() });
            } else {
                throw new Error(`unsupported wire type ${wire}`);
            }
        }
    } catch (error) {
        if (depth === 0) return { error: error.message, hex: buffer.toString('hex') };
        throw error;
    }
    return { fields };
}

function knownType(root, service, method, messageType) {
    const request = messageType === 1;
    const names = {
        'gamepb.itempb.ItemService.Bag': request ? 'gamepb.itempb.BagRequest' : 'gamepb.itempb.BagReply',
        'gamepb.itempb.ItemService.Use': request ? 'gamepb.itempb.UseRequest' : 'gamepb.itempb.UseReply',
        'gamepb.itempb.ItemService.BatchUse': request ? 'gamepb.itempb.BatchUseRequest' : 'gamepb.itempb.BatchUseReply',
        'gamepb.taskpb.TaskService.TaskInfo': request ? 'gamepb.taskpb.TaskInfoRequest' : 'gamepb.taskpb.TaskInfoReply',
        'gamepb.taskpb.TaskService.ClaimTaskReward': request ? 'gamepb.taskpb.ClaimTaskRewardRequest' : 'gamepb.taskpb.ClaimTaskRewardReply',
        'gamepb.seasonpb.SeasonService.GetSeasonInfo': request ? 'gamepb.seasonpb.GetSeasonInfoRequest' : 'gamepb.seasonpb.GetSeasonInfoReply',
        'gamepb.activitypb.ActivityService.Operate': request ? null : 'gamepb.activitypb.ActivityOperateReply',
    };
    const name = names[`${service}.${method}`];
    return name ? root.lookupType(name) : null;
}

async function main() {
    const root = new protobuf.Root();
    await root.load(protoFiles, { keepCase: true });
    const gate = root.lookupType('gatepb.Message');
    const names = fs.readdirSync(captureDir).filter((name) => name.endsWith('.bin')).sort();
    for (const name of names) {
        let message;
        try {
            message = gate.decode(fs.readFileSync(path.join(captureDir, name)));
        } catch {
            continue;
        }
        const meta = message.meta || {};
        const service = String(meta.service_name || '');
        const method = String(meta.method_name || '');
        if (!selected.has(`${service}.${method}`)) continue;

        const messageType = Number(meta.message_type);
        let body = Buffer.from(message.body || []);
        if (messageType === 1 && body.length) body = await cryptoWasm.decryptBuffer(body);
        const type = knownType(root, service, method, messageType);
        let known = null;
        if (type) {
            try {
                const decoded = type.decode(body);
                known = type.toObject(decoded, { longs: String, enums: String, bytes: String });
            } catch (error) {
                known = { error: error.message };
            }
        }
        console.log(JSON.stringify({
            file: name,
            direction: messageType === 1 ? 'SEND' : 'RECV',
            service,
            method,
            clientSeq: scalar(meta.client_seq),
            errorCode: scalar(meta.error_code),
            errorMessage: String(meta.error_message || ''),
            bodyHex: body.toString('hex'),
            known,
            raw: rawFields(body),
        }));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
