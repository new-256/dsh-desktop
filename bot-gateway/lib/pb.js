/**
 * @file lib/pb.js
 * @description 极简手写 Protobuf 编解码库，专门支持飞书长连接协议要求的 pbbp2.Frame 与 pbbp2.Header 消息结构。
 */

/**
 * 编码 Varint (支持 BigInt / Number)
 * @param {number|bigint} val 
 * @returns {number[]} 字节数组
 */
export function encodeVarint(val) {
  const bytes = [];
  let n = BigInt(val);
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n & 0x7fn));
  return bytes;
}

/**
 * 解码 Varint (截断到 Number.MAX_SAFE_INTEGER)
 * @param {Uint8Array} u8arr 
 * @param {number} offset 
 * @returns {{ val: number, nextOffset: number }}
 */
export function decodeVarint(u8arr, offset) {
  let res = 0n;
  let shift = 0n;
  let i = offset;
  while (i < u8arr.length) {
    const b = u8arr[i++];
    res |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if ((b & 0x80) === 0) break;
  }
  const numRes = Number(res & 0x7fffffffffffffn);
  return { val: numRes, nextOffset: i };
}

/**
 * 跳过未知 protobuf 字段
 */
function skipField(u8arr, offset, wireType) {
  if (wireType === 0) {
    return decodeVarint(u8arr, offset).nextOffset;
  } else if (wireType === 1) {
    return offset + 8;
  } else if (wireType === 2) {
    const { val: len, nextOffset } = decodeVarint(u8arr, offset);
    return nextOffset + len;
  } else if (wireType === 5) {
    return offset + 4;
  }
  throw new Error(`跳过未知 WireType: ${wireType}`);
}

/**
 * 编码 Header 消息: { key, value }
 * message Header { string key = 1; string value = 2; }
 */
export function encodeHeader(header) {
  const bytes = [];

  if (header.key) {
    const keyBuf = new TextEncoder().encode(header.key);
    bytes.push((1 << 3) | 2); // tag = 0x0a
    bytes.push(...encodeVarint(keyBuf.length));
    bytes.push(...keyBuf);
  }

  if (header.value) {
    const valBuf = new TextEncoder().encode(header.value);
    bytes.push((2 << 3) | 2); // tag = 0x12
    bytes.push(...encodeVarint(valBuf.length));
    bytes.push(...valBuf);
  }

  return new Uint8Array(bytes);
}

/**
 * 解码 Header 消息
 */
export function decodeHeader(u8arr) {
  let offset = 0;
  let key = '';
  let value = '';

  while (offset < u8arr.length) {
    const { val: tag, nextOffset: tagOffset } = decodeVarint(u8arr, offset);
    offset = tagOffset;
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 1 && wireType === 2) {
      const { val: len, nextOffset: lenOffset } = decodeVarint(u8arr, offset);
      offset = lenOffset;
      key = new TextDecoder().decode(u8arr.subarray(offset, offset + len));
      offset += len;
    } else if (fieldNum === 2 && wireType === 2) {
      const { val: len, nextOffset: lenOffset } = decodeVarint(u8arr, offset);
      offset = lenOffset;
      value = new TextDecoder().decode(u8arr.subarray(offset, offset + len));
      offset += len;
    } else {
      offset = skipField(u8arr, offset, wireType);
    }
  }

  return { key, value };
}

/**
 * 编码 Frame 消息
 * message Frame {
 *   uint64 SeqID = 1; uint64 LogID = 2; int32 service = 3; int32 method = 4;
 *   repeated Header headers = 5; string payloadEncoding = 6; string payloadType = 7;
 *   bytes payload = 8; string LogIDNew = 9;
 * }
 * @param {object} frame 
 * @returns {Uint8Array}
 */
export function encodeFrame(frame) {
  const bytes = [];

  // field 1: SeqID (uint64, wire 0)
  if (frame.SeqID) {
    bytes.push((1 << 3) | 0);
    bytes.push(...encodeVarint(frame.SeqID));
  }

  // field 2: LogID (uint64, wire 0)
  if (frame.LogID) {
    bytes.push((2 << 3) | 0);
    bytes.push(...encodeVarint(frame.LogID));
  }

  // field 3: service (int32, wire 0)
  if (frame.service) {
    bytes.push((3 << 3) | 0);
    bytes.push(...encodeVarint(frame.service));
  }

  // field 4: method (int32, wire 0)
  if (frame.method) {
    bytes.push((4 << 3) | 0);
    bytes.push(...encodeVarint(frame.method));
  }

  // field 5: headers (repeated Header, wire 2)
  if (Array.isArray(frame.headers)) {
    for (const h of frame.headers) {
      const hBuf = encodeHeader(h);
      bytes.push((5 << 3) | 2);
      bytes.push(...encodeVarint(hBuf.length));
      bytes.push(...hBuf);
    }
  }

  // field 6: payloadEncoding (string, wire 2)
  if (frame.payloadEncoding) {
    const buf = new TextEncoder().encode(frame.payloadEncoding);
    bytes.push((6 << 3) | 2);
    bytes.push(...encodeVarint(buf.length));
    bytes.push(...buf);
  }

  // field 7: payloadType (string, wire 2)
  if (frame.payloadType) {
    const buf = new TextEncoder().encode(frame.payloadType);
    bytes.push((7 << 3) | 2);
    bytes.push(...encodeVarint(buf.length));
    bytes.push(...buf);
  }

  // field 8: payload (bytes, wire 2)
  if (frame.payload) {
    const pBuf = typeof frame.payload === 'string'
      ? new TextEncoder().encode(frame.payload)
      : frame.payload;
    bytes.push((8 << 3) | 2);
    bytes.push(...encodeVarint(pBuf.length));
    bytes.push(...pBuf);
  }

  // field 9: LogIDNew (string, wire 2)
  if (frame.LogIDNew) {
    const buf = new TextEncoder().encode(frame.LogIDNew);
    bytes.push((9 << 3) | 2);
    bytes.push(...encodeVarint(buf.length));
    bytes.push(...buf);
  }

  return new Uint8Array(bytes);
}

/**
 * 解码 Frame 消息
 * @param {Uint8Array} u8arr 
 * @returns {object} frameObj
 */
export function decodeFrame(u8arr) {
  let offset = 0;
  const frame = {
    SeqID: 0,
    LogID: 0,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: '',
    payloadType: '',
    payload: new Uint8Array(0),
    LogIDNew: ''
  };

  while (offset < u8arr.length) {
    const { val: tag, nextOffset: tagOffset } = decodeVarint(u8arr, offset);
    offset = tagOffset;
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 1 && wireType === 0) {
      const { val, nextOffset } = decodeVarint(u8arr, offset);
      frame.SeqID = val;
      offset = nextOffset;
    } else if (fieldNum === 2 && wireType === 0) {
      const { val, nextOffset } = decodeVarint(u8arr, offset);
      frame.LogID = val;
      offset = nextOffset;
    } else if (fieldNum === 3 && wireType === 0) {
      const { val, nextOffset } = decodeVarint(u8arr, offset);
      frame.service = val;
      offset = nextOffset;
    } else if (fieldNum === 4 && wireType === 0) {
      const { val, nextOffset } = decodeVarint(u8arr, offset);
      frame.method = val;
      offset = nextOffset;
    } else if (fieldNum === 5 && wireType === 2) {
      const { val: len, nextOffset } = decodeVarint(u8arr, offset);
      offset = nextOffset;
      const hBuf = u8arr.subarray(offset, offset + len);
      frame.headers.push(decodeHeader(hBuf));
      offset += len;
    } else if (fieldNum === 6 && wireType === 2) {
      const { val: len, nextOffset } = decodeVarint(u8arr, offset);
      offset = nextOffset;
      frame.payloadEncoding = new TextDecoder().decode(u8arr.subarray(offset, offset + len));
      offset += len;
    } else if (fieldNum === 7 && wireType === 2) {
      const { val: len, nextOffset } = decodeVarint(u8arr, offset);
      offset = nextOffset;
      frame.payloadType = new TextDecoder().decode(u8arr.subarray(offset, offset + len));
      offset += len;
    } else if (fieldNum === 8 && wireType === 2) {
      const { val: len, nextOffset } = decodeVarint(u8arr, offset);
      offset = nextOffset;
      frame.payload = u8arr.subarray(offset, offset + len);
      offset += len;
    } else if (fieldNum === 9 && wireType === 2) {
      const { val: len, nextOffset } = decodeVarint(u8arr, offset);
      offset = nextOffset;
      frame.LogIDNew = new TextDecoder().decode(u8arr.subarray(offset, offset + len));
      offset += len;
    } else {
      offset = skipField(u8arr, offset, wireType);
    }
  }

  return frame;
}
