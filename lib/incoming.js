"use strict";
const zlib = require("zlib");
const Readable = require("stream").Readable;
const tea = require('crypto-tea');
const ecdh = require("./ecdh");
const {parseMessage} = require("./message");
const {downloadRichMsg} = require("./service");
const common = require("./common");
const pb = require("./pb");
const jce = require("./jce");
const outgoing = require("./outgoing");
const event = require("./event");
const toInt = common.toInt;

/**
 * @param {Buffer} buf 
 * @returns {Object}
 */
function parseSSO(buf) {
    const stream = Readable.from(buf, {objectMode:false});
    stream.read(0);
    if (stream.read(4).readInt32BE() - 4 > stream.readableLength) {
        throw new Error("dropped");
    }
    const seq_id = stream.read(4).readInt32BE();
    const retcode = stream.read(4).readInt32BE();
    if (retcode) {
        throw new Error("return code unsuccessful: " + retcode);
    }
    stream.read(stream.read(4).readInt32BE() - 4);
    const command_name = stream.read(stream.read(4).readInt32BE() - 4).toString();
    const session_id = stream.read(stream.read(4).readInt32BE() - 4);
    if (command_name === "Heartbeat.Alive") {
        return {
            seq_id, command_name, session_id, payload: Buffer.alloc(0)
        };
    }

    const compressed = stream.read(4).readInt32BE();
    var payload;
    if (compressed === 0) {
        stream.read(4);
        payload = stream.read();
    } else if (compressed === 1) {
        stream.read(4);
        payload = zlib.unzipSync(stream.read());
    } else if (compressed === 8) {
        payload = stream.read();
    } else
        throw new Error("unknown compressed flag: " + compressed)
    return {
        seq_id, command_name, session_id, payload
    };
}

/**
 * @param {Buffer} buf 
 * @returns {Buffer}
 */
function parseOICQ(buf) {
    const stream = Readable.from(buf, {objectMode:false});
    if (stream.read(1).readUInt8() !== 2) {
        throw new Error("unknown flag");
    }
    stream.read(12);
    const encrypt_type = stream.read(2).readUInt16BE();
    stream.read(1)
    if (encrypt_type === 0) {
        const encrypted = stream.read(stream.readableLength - 1);
        let decrypted = tea.decrypt(encrypted, ecdh.share_key);
        return decrypted;
    } else if (encrypt_type === 4) {
        throw new Error("todo");
    } else
        throw new Error("unknown encryption method: " + encrypt_type);
}

//----------------------------------------------------------------------------------------------

/**
 * @param {Readable} stream 
 * @param {Number} size 
 * @returns {Object}
 */
function readTlv(stream, size) {
    const t = {};
    var k;
    while(true) {
        if (stream.readableLength < size)
            break;
        if (size === 1)
            k = stream.read(1).readUInt8();
        else if (size === 2)
            k = stream.read(2).readUInt16BE();
        else if (size === 4)
            k = stream.read(4).readInt32BE();
        if (k === 255)
            break;
        t[k] = stream.read(stream.read(2).readUInt16BE())
    }
    return t;
}

function decodeT161(data, c) {
    const stream = Readable.from(data, {objectMode:false});
    stream.read(2);
    c.rollback_sig = readTlv(stream, 2)[0x172];
}
function decodeT119(data, c) {
    const reader = Readable.from(tea.decrypt(data, c.device_info.tgtgt_key), {objectMode:false});
    reader.read(2);
    const t = readTlv(reader, 2);
    if (t[0x130])
        decodeT130(t[0x130], c);
    c.t528 = t[0x528];
    c.t530 = t[0x530];
    c.ksid = t[0x108];
    if (t[0x186])
        decodeT186(t[0x186], c)
    if (t[0x11a])
        [c.nickname, c.age, c.gender] = readT11A(t[0x11a]);
    c.sign_info = {
        bitmap:         0,
        tgt:            t[0x10a],
        tgt_key:        t[0x10d],
        st_key:         t[0x10e],
        st_web_sig:     t[0x103],
        s_key:          t[0x120],
        d2:             t[0x143],
        d2key:          t[0x305],
        ticket_key:     t[0x134],
        device_token:   t[0x322],
    }
}
function decodeT130(data, c) {
    const stream = Readable.from(data, {objectMode:false});
    stream.read(2);
    c.time_diff = stream.read(4).readInt32BE() - common.timestamp();
    c.t149 = stream.read(4);
}
function decodeT186(data, c) {
    c.pwd_flag = data[1] === 1;
}
function readT11A(data) {
    const stream = Readable.from(data, {objectMode:false});
    stream.read(2);
    const age = stream.read(1).readUInt8();
    const gender = stream.read(1).readUInt8();
    const nickname = stream.read(stream.read(1).readUInt8() & 0xff).toString();
    return [nickname, age, gender];
}

//----------------------------------------------------------------------------------------------

/**
 * @returns {void}
 */
function decodeLoginResponse(blob, c) {
    const stream = Readable.from(blob, {objectMode:false});
    stream.read(2);
    const type = stream.read(1).readUInt8();
    stream.read(2);
    const t = readTlv(stream, 2);
    if (type === 0) { //success
        c.t150 = t[0x150];
        if (t[0x161])
            decodeT161(t[0x161], c);
        decodeT119(t[0x119], c);
        return event.emit(c, "internal.login");
    }
    if (type === 2) { //captcha
        c.t104 = t[0x104]
        if (t[0x192]) { //slider captcha, not supported yet
            c.logger.error("收到滑动验证码，暂不支持。");
            return event.emit(c, "system.login.error", {
                message: `[登陆失败]暂不支持滑动验证码。`
            });
        }
        if (t[0x165]) { //image captcha
            const stream = Readable.from(t[0x105], {objectMode:false});
            const signLen = stream.read(2).readUInt16BE();
            stream.read(2);
            c.captcha_sign = stream.read(signLen);
            const image = stream.read();
            c.logger.info("收到图片验证码。");
            return event.emit(c, "system.login.captcha", {image});
        }
        c.logger.error("收到未知格式的验证码，暂不支持。");
        return event.emit(c, "system.login.error", {
            message: `[登陆失败]未知格式的验证码。`
        });
    }

    if (type === 160) {
        const url = t[0x204].toString();
        c.logger.info("需要验证设备信息，验证地址：" + url);
        return event.emit(c, "system.login.device", {url});
    }

    if (type === 204) {
        c.t104 = t[0x104];
        c.logger.info("login...");
        return c.write(outgoing.buildDeviceLoginRequestPacket(t[0x402], c));
    }

    if (t[0x149]) {
        const stream = Readable.from(t[0x149], {objectMode:false});
        stream.read(2);
        const title = stream.read(stream.read(2).readUInt16BE()).toString();
        const content = stream.read(stream.read(2).readUInt16BE()).toString();
        const message = `[${title}]${content}`;
        c.logger.error(message);
        return event.emit(c, "system.login.error", {message});
    }

    if (t[0x146]) {
        const stream = Readable.from(t[0x146], {objectMode:false});
        const version = stream.read(4);
        const title = stream.read(stream.read(2).readUInt16BE()).toString();
        const content = stream.read(stream.read(2).readUInt16BE()).toString();
        const message = `[${title}]${content}`;
        c.logger.error(message);
        return event.emit(c, "system.login.error", {message});
    }

    c.logger.error("[登陆失败]未知错误。");
    event.emit(c, "system.login.error", {
        message: `[登陆失败]未知错误。`
    });
}

/**
 * @returns {boolean}
 */
function decodeClientRegisterResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[9]?true:false;
}
function decodePushReqEvent(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    c.write(outgoing.buildConfPushResponsePacket(parent[1], parent[3], parent[2], c));
}

//----------------------------------------------------------------------------------------------------

/**
 * @returns {void}
 */
async function decodeMessageSvcResponse(blob, c) {
    const o = pb.decode("GetMessageResponse", blob);
    if (o.resule > 0){
        c.sync_finished = true;
        return;
    }
    // common.log(o);
    c.sync_cookie = o.syncCookie;
    const messages = [];
    const rubbish = [];
    for (let v of o.uinPairMsgs) {
        if (!v.messages) continue;
        for (let msg of v.messages) {
            const head = msg.head, body = msg.body;
            const type = head.msgType;
            const rrr = head;
            rrr.msgType = 187;
            rubbish.push(rrr);
            if (!c.sync_finished)
                continue;
            let user_id = toInt(head.fromUin);
            if (user_id === c.uin)
                continue;
            const msg_uid = toInt(head.msgUid) * head.msgSeq;
            if (c.seq_cache.MessageSvc.has(msg_uid))
                continue;
            c.seq_cache.MessageSvc.add(msg_uid);
            messages.push(msg_uid);
            if (type === 84 || type === 87) {
                c.write(outgoing.buildNewGroupRequestPacket(1, c));
                continue;
            } else if (type === 187) {
                c.write(outgoing.buildNewFriendRequestPacket(1, c));
                continue;
            } else if (type === 33) {
                const group_id = common.uin2code(user_id);
                user_id = toInt(head.authUin);
                if (user_id === c.uin)
                    await c.getGroupList(true);
                c.getGroupMemberList(group_id, true);
                try {
                    c.group_list.get(group_id).member_count++;
                    c.group_list.get(group_id).last_join_time = common.timestamp();
                } catch (e) {}
                event.emit(c, "notice.group.increase", {
                    group_id, user_id,
                    nickname: head.authNick
                });
                continue;
            }
            let sub_type, message_id, font, sender = {user_id};
            if (type === 141) {
                sub_type = "other";
                if (head.c2cTmpMsgHead && head.c2cTmpMsgHead.groupCode) {
                    sub_type = "group";
                    const group_id = toInt(head.c2cTmpMsgHead.groupCode);
                    try {
                        sender = c.group_member_list.get(group_id).get(user_id);
                    } catch (e) {}
                }
            } else if (type === 166) {
                sub_type = "friend";
                try {
                    sender = c.friend_list.get(user_id);
                } catch (e) {}
            } else if (type === 167) {
                sub_type = "single";
            } else {
                continue;
            }
            if (body.richText && body.richText.elems) {
                message_id = common.genGroupMessageId(user_id, head.msgSeq, body.richText.attr.random);
                font = body.richText.attr.fontName;
                const {chain, raw_message} = parseMessage(body.richText.elems);
                c.logger.info(`recv from: [Private: ${user_id}(${sub_type})] ` + raw_message);
                if (raw_message)
                    event.emit(c, "message.private." + sub_type, {
                        message_id, user_id, message: chain, raw_message, font, sender, time: head.msgTime
                    });
            }
        }
    }
    if (messages.length) {
        setTimeout(()=>{
            messages.forEach((v)=>{
                c.seq_cache.MessageSvc.delete(v);
            })
        }, 300000);
    }
    c.write(outgoing.buildDeleteMessageRequestPacket(rubbish, c));
    if (o.syncFlag !== 2) {
        c.write(outgoing.buildGetMessageRequestPacket(o.syncFlag, c));
    } else {
        c.sync_finished = true;
    }
    if (common.timestamp() - c.friend_list_uptime > 900)
        c.getFriendList(true);
}

async function decodePushNotifyEvent(blob, c) {
    if (c.sync_lock) return;
    try {
        c.sync_lock = true;
        await c.send(outgoing.buildGetMessageRequestPacket(0, c));
    } catch (e) {}
    c.sync_lock = false;
}

async function decodeGroupMessageEvent(blob, c) {
    const o = pb.decode("PushMessagePacket", blob);
    // common.log(o);
    const head = o.message.head, body = o.message.body, user_id = toInt(head.fromUin);
    const group = head.groupInfo, group_id = toInt(group.groupCode), group_name = group.groupName.toString();
    const message_id = common.genGroupMessageId(group_id, head.msgSeq, body.richText.attr.random);
    if (user_id === c.uin) {
        c.emit(`interval.${group_id}.${body.richText.attr.random}`, message_id);
        if (c.ignore_self) return;
    }

    if (!await c.hasGroup(group_id))
        return;
    if (!c.group_member_list.has(group_id))
        await c.getGroupMemberList(group_id, true);
    else if (common.timestamp() - c.group_list.get(group_id).member_list_uptime > 900)
        c.getGroupMemberList(group_id, true);

    const font = body.richText.attr.fontName, card = group.groupCard;
    let anonymous = null, user = null;
    if (user_id === 80000000) {
        anonymous = {
            id:0, name: card, flag: ""
        };
    } else {
        try {
            user = c.group_member_list.get(group_id).get(user_id);
            user.card = card;
            user.last_sent_time = common.timestamp();
        } catch (e) {}
    }
    if (user) {
        var {nickname, sex, age, area, level, role, title} = user;
    } else {
        var nickname = card, sex = "unknown", age = 0, area = "", level = 0, role = "member", title = "";
    }
    const sender = {
        user_id, nickname, card, sex, age, area, level, role, title
    };

    if (common.timestamp() - c.group_list_uptime > 900)
        c.getGroupList(true);

    let res = parseMessage(body.richText.elems);
    if (typeof res === "string") {
        try {
            // const resp = await c.send(outgoing.buildMultiApplyDownRequestPacket(res, c));
            // common.log(resp)
            // res = await downloadRichMsg(resp);
            // common.log(res)
            return;
        } catch (e) {return}
    }

    const {chain, raw_message} = res;
    // if (body.richText.ptt) {}

    if (!raw_message)
        return;

    const sub_type = anonymous ? "anonymous" : "normal";
    c.logger.info(`recv from: [Group: ${group_name}(${group_id}), Member: ${card}(${user_id})] ` + raw_message);
    event.emit(c, "message.group." + sub_type, {
        message_id, group_id, group_name, user_id, anonymous, message: chain, raw_message, font, sender, time: head.msgTime
    });
}

//----------------------------------------------------------------------------------------------------

const friend_sex_map = {
    "0":"unknown", "1":"male", "2":"female"
};
const group_sex_map = {
    "-1":"unknown", "0":"male", "1":"female"
};

/**
 * @returns {Number} 好友总数
 */
function decodeFriendListResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    for (let v of parent[7]) {
        v = jce.decode(v);
        c.friend_list.set(v[0], {
            user_id:    v[0],
            nickname:   v[14],
            remark:     v[3],
            sex:        friend_sex_map[v[31]],
            age:        0, //暂无
            is_friend:  true,
        })
    }
    return parent[5];
}

/**
 * @returns {void}
 */
function decodeGroupListResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    c.group_list = new Map();
    let uptime = 0;
    try {
        uptime = c.group_list.get(group_list).member_list_uptime;
    } catch (e) {}
    for (let v of parent[5]) {
        v = jce.decode(v);
        c.group_list.set(v[1], {
            group_id:           v[1],
            group_name:         v[4],
            member_count:       v[19],
            max_member_count:   v[29],
            owner_id:           v[23],
            last_join_time:     v[27],
            member_list_uptime: uptime,
        });
    }
}

/**
 * @returns {Number} 下一个uin
 */
function decodeGroupMemberListResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    const group_id = parent[1];
    if (!parent[3].length || !c.group_list.has(group_id)) {
        c.group_list.delete(group_id);
        c.group_member_list.delete(group_id);
        return 0;
    } else {
        c.group_list.get(group_id).member_list_uptime = common.timestamp();
    }
    const member_list = c.group_member_list.get(group_id);
    for (let v of parent[3]) {
        v = jce.decode(v);
        member_list.set(v[0], {
            group_id:           group_id,
            user_id:            v[0],
            nickname:           v[4],
            card:               v[8],
            sex:                group_sex_map[v[3]],
            age:                v[2],
            area:               "unknown",
            join_time:          v[15],
            last_sent_time:     v[16],
            level:              v[14],
            role:               v[18] ? "admin" : "member",
            unfriendly:         false,
            title:              v[23],
            title_expire_time:  v[24] === 4294967295 ? -1 : v[24],
            card_changeable:    true,
        });
    }
    try {
        const owner = c.group_list.get(group_id).owner_id;
        member_list.get(owner).role = "owner";
    } catch (e) {}
    return parent[4];
}

//----------------------------------------------------------------------------------------------------

function decodeNewFriendResponse(blob, c) {
    // if (!c.sync_finished) return;
    const o = pb.decode("RspSystemMsgNew", blob);
    // common.log(o)
    const list = o.friendmsgs.slice(0, 1);
    for (let v of list) {
        const user_id = toInt(v.reqUin);
        event.emit(c, "request.friend.add", {
            user_id:    user_id,
            nickname:   v.msg.reqUinNick,
            source:     v.msg.msgSource,
            comment:    v.msg.msgAdditional,
            sex:        "unknown",
            age:        v.msg.reqUinAge,
            flag:       common.genFriendRequestFlag(user_id, v.msgSeq),
        });
    }
}
function decodeNewGroupResponse(blob, c) {
    // if (!c.sync_finished) return;
    const o = pb.decode("RspSystemMsgNew", blob);
    // common.log(o)
    const list = o.groupmsgs.slice(0, 1);
    for (let v of list) {
        if (v.msg.subType === 1) {
            const group_id = toInt(v.msg.groupCode); 
            if (v.msg.groupMsgType === 1) {
                const user_id = toInt(v.reqUin);
                event.emit(c, "request.group.add", {
                    group_id:   group_id,
                    group_name: v.msg.groupName,
                    user_id:    user_id,
                    nickname:   v.msg.reqUinNick,
                    comment:    v.msg.msgAdditional,
                    flag:       common.genGroupRequestFlag(user_id, group_id, v.msgSeq),
                });
            } else if (v.msg.groupMsgType === 2) {
                const user_id = toInt(v.msg.actionUin);
                event.emit(c, "request.group.invite", {
                    group_id:   group_id,
                    group_name: v.msg.groupName,
                    user_id:    user_id,
                    nickname:   v.msg.actionUinNick,
                    role:       v.msg.groupInviterRole === 1 ? "member" : "admin",
                    flag:       common.genGroupRequestFlag(user_id, group_id, v.msgSeq, 1),
                });
            }
        }
    }
}

//----------------------------------------------------------------------------------------------------

async function decodeFriendAndGroupEvent(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    if (c.seq_cache["ReqPush"].has(parent[3]))
        return;
    c.seq_cache["ReqPush"].add(parent[3]);
    setTimeout(()=>{
        c.seq_cache["ReqPush"].delete(parent[3]);
    }, 30000);
    const list = parent[2];
    for (let v of list) {
        v = jce.decode(v);
        if (v[2] === 528) {
            let data = jce.decode(v[6]);
            if (data[0] === 0x8A || data[0] === 0x8B) {
                data = pb.decode("Sub8A", data[10]);
                data = data.msgInfo[0];
                const user_id = toInt(data.fromUin);
                event.emit(c, "notice.friend.recall", {
                    user_id: user_id,
                    message_id: common.genGroupMessageId(user_id, data.msgSeq, data.msgRandom)
                });
            } else if (data[0] === 0xB3) {
                data = pb.decode("SubB3", data[10]);
                await c.getFriendList(true);
                event.emit(c, "notice.friend.increase", {
                    user_id: toInt(data.msgAddFrdNotify.uin), nickname: data.msgAddFrdNotify.nick
                });
            } else if (data[0] === 0xD4) {
                data = pb.decode("SubD4", data[10])
                const group_id = toInt(data.uin);
                c.group_list.delete(group_id);
                c.group_member_list.delete(group_id);
            }
            // if (data[0] === 0x27) {
                
            // }
        } else if (v[2] === 732) {
            const group_id = v[6].readUInt32BE();
            if (v[6][4] === 0x0C) {
                const operator_id = v[6].readUInt32BE(6);
                const user_id = v[6].readUInt32BE(16);
                const duration = v[6].readUInt32BE(20);
                event.emit(c, "notice.group.ban", {
                    group_id, operator_id, user_id, duration
                });
            }
            if (v[6][4] === 0x11) {
                const data = pb.decode("NotifyMsgBody", v[6].slice(7));
                const operator_id = toInt(data.optMsgRecall.uin);
                const msg = data.optMsgRecall.recalledMsgList[0];
                const user_id = toInt(msg.authorUin);
                const message_id = common.genGroupMessageId(group_id, msg.seq, msg.msgRandom);
                event.emit(c, "notice.group.recall", {
                    group_id, user_id, operator_id, message_id
                });
            }
        }
    }
}
function decodeGroupMemberEvent(blob, c) {
    const o = pb.decode("TransMsgInfo", blob);
    // common.log(o);
    if (c.seq_cache["PbPush"].has(o.msgSeq))
        return;
    c.seq_cache["PbPush"].add(o.msgSeq);
    setTimeout(()=>{
        c.seq_cache["PbPush"].delete(o.msgSeq);
    }, 30000);
    const buf = o.msgData;
    const group_id = buf.readUInt32BE();
    if (o.msgType === 44) {
        if (buf[5] === 0 || buf[5] === 1) {
            const user_id = buf.readUInt32BE(6);
            const set = buf[10] > 0;
            try {
                c.group_member_list.get(group_id).get(user_id).role = (set ? "admin" : "member");
            } catch (e) {}
            event.emit(c, "notice.group.admin", {
                group_id, user_id, set
            });
        } else if (buf[5] === 0xFF) {
            const old_owner_id = buf.readUInt32BE(6);
            const new_owner_id = buf.readUInt32BE(10);
            try {
                c.group_list.get(group_id).owner_id = new_owner_id;
                c.group_member_list.get(group_id).get(old_owner_id).role = "member";
                c.group_member_list.get(group_id).get(new_owner_id).role = "owner";
            } catch (e) {}
            event.emit(c, "notice.group.transfer", {
                group_id, old_owner_id, new_owner_id
            });
        }
    }
    if (o.msgType === 34) {
        const user_id = buf.readUInt32BE(5);
        let operator_id, dismiss = false;
        if (buf[9] === 0x82 || buf[9] === 0x2) {
            operator_id = user_id;
            if (c.group_member_list.has(group_id))
                c.group_member_list.get(group_id).delete(user_id);
        } else {
            operator_id = buf.readUInt32BE(10);
            if (buf[9] === 0x01)
                dismiss = true;
            if (user_id === c.uin) {
                c.group_list.delete(group_id);
                c.group_member_list.delete(group_id);
            } else {
                if (c.group_member_list.has(group_id))
                    c.group_member_list.get(group_id).delete(user_id);
            }
        }
        try {
            c.group_list.get(group_list).member_count--;
        } catch (e) {}
        event.emit(c, "notice.group.decrease", {
            group_id, user_id, operator_id, dismiss
        });
    }
}

//----------------------------------------------------------------------------------------------------

function decodeForceOfflineEvent(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    event.emit(c, "internal.kickoff", {
        type: "PushForceOffline",
        info: `[${parent[1]}]${parent[2]}`,
    });
}
function decodeReqMSFOfflineEvent(blob, c) {
    // const nested = jce.decodeWrapper(blob);
    // const parent = jce.decode(nested);
    // // console.log(parent);
    // event.emit(c, "internal.kickoff", {
    //     type: "ReqMSFOffline",
    //     info: `[${parent[4]}]${parent[3]}`,
    // });
}

function decodeSendMessageResponse(blob, c) {
    return pb.decode("PbSendMsgResp", blob);
}
function decodeDeleteMessageResponse(blob, c) {
    // console.log(pb.decode("PbDeleteMsgResp", blob))
}
function decodeRecallMessageResponse() {}
function decodeNewFriendActionResponse() {}
function decodeNewGroupActionResponse() {}

function decodeEditGroupCardResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[3].length > 0;
}

/**
 * @returns {boolean}
 */
function decodeGroupLeaveResponse(blob, c) {
    const nested = jce.decodeWrapper(blob);
    const parent = jce.decode(nested);
    return parent[1];
}
/**
 * @returns {boolean}
 */
function decodeGroupKickResponse(blob, c) {
    const o = pb.decode("OIDBSSOPkg", blob);
    const body = pb.decode("D8A0RspBody", o.bodybuffer);
    return body.msgKickResult[0].optUint32Result === 0;
}
function decodeGroupBanResponse(blob, c) {}

//----------------------------------------------------------------------------------------------------

function decodeImageStoreResponse(blob, c) {
    return pb.decode("D388RespBody", blob);
}
function decodeOffPicUpResponse(blob, c) {
    return pb.decode("RspBody", blob);
}
function decodeMultiApplyUpRequestResponse(blob, c) {
    return pb.decode("MultiRspBody", blob);
}
function decodeMultiApplyDownRequestResponse(blob, c) {
    return pb.decode("MultiRspBody", blob);
}

//----------------------------------------------------------------------------------------------------

const CMD = outgoing.CMD;
const decoders = new Map([
    [CMD.LOGIN,             decodeLoginResponse],
    [CMD.REGISTER,          decodeClientRegisterResponse],

    [CMD.GET_MSG,           decodeMessageSvcResponse],
    [CMD.SEND_MSG,          decodeSendMessageResponse],
    [CMD.DELETE_MSG,        decodeDeleteMessageResponse],
    [CMD.RECALL,            decodeRecallMessageResponse],

    [CMD.FRIEND_LIST,       decodeFriendListResponse],
    [CMD.GROUP_LIST,        decodeGroupListResponse],
    [CMD.MEMBER_LIST,       decodeGroupMemberListResponse],

    [CMD.FRIEND_REQ,        decodeNewFriendResponse],
    [CMD.FRIEND_REQ_ACT,    decodeNewFriendActionResponse],
    [CMD.GROUP_REQ,         decodeNewGroupResponse],
    [CMD.GROUP_REQ_ACT,     decodeNewGroupActionResponse],
    
    [CMD.GROUP_MSG,         decodeGroupMessageEvent],
    [CMD.PUSH_NOTIFY,       decodePushNotifyEvent],
    [CMD.ONLINE_PUSH,       decodeFriendAndGroupEvent],
    [CMD.ONLINE_PB_PUSH,    decodeGroupMemberEvent],

    [CMD.GROUP_CARD,        decodeEditGroupCardResponse],
    [CMD.GROUP_LEAVE,       decodeGroupLeaveResponse],
    [CMD.GROUP_KICK,        decodeGroupKickResponse],
    [CMD.GROUP_BAN,         decodeGroupBanResponse],

    [CMD.PUSH_REQ,          decodePushReqEvent],
    [CMD.OFFLINE,           decodeForceOfflineEvent],
    [CMD.MFS_OFFLINE,       decodeReqMSFOfflineEvent],

    [CMD.IMG_STORE,         decodeImageStoreResponse],
    [CMD.OFF_PIC_UP,        decodeOffPicUpResponse],
    [CMD.MULTI_UP,          decodeMultiApplyUpRequestResponse],
    [CMD.MULTI_DOWN,        decodeMultiApplyDownRequestResponse],
]);

//----------------------------------------------------------------------------------------------

/**
 * @param {Buffer} packet 
 * @param {Client}
 * @returns {void}
 */
module.exports = function parseIncomingPacket(packet, c) {
    const stream = Readable.from(packet, {objectMode:false});
    const flag1 = stream.read(4).readInt32BE();
    if (flag1 !== 0x0A && flag1 !== 0x0B)
        throw new Error("decrypt failed");
    const flag2 = stream.read(1).readUInt8();
    const flag3 = stream.read(1).readUInt8();
    if (flag3 !== 0)
        throw new Error("unknown flag");
    stream.read(stream.read(4).readInt32BE() - 4);
    let decrypted = stream.read();
    switch (flag2) {
        case 0:
            break;
        case 1:
            decrypted = tea.decrypt(decrypted, c.sign_info.d2key);
            break;
        case 2:
            decrypted = tea.decrypt(decrypted, Buffer.alloc(16));
            break;
        default:
            decrypted = Buffer.alloc(0)
            break;
    }
    if (!decrypted.length)
        throw new Error("decrypt failed");
 
    const sso = parseSSO(decrypted);
    c.logger.trace(`recv:${sso.command_name} seq:${sso.seq_id}`);

    let ret;
    if (flag2 === 2)
        sso.payload = parseOICQ(sso.payload);
    if (decoders.has(sso.command_name))
        ret = decoders.get(sso.command_name)(sso.payload, c);
    if (c.handlers.has(sso.seq_id))
        c.handlers.get(sso.seq_id)(ret);
};
