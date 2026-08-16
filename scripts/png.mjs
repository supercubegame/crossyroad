/* 零依赖 PNG 解码器。zlib 是 Node 自带的，所以这个文件能进快闸门。

   为什么要它：截图之前只有两条弱断言（互不相同、字节非空），真正的内容断言
   全在 canvas 像素上,于是 PNG 编码那一层完全没人看着。那是一个覆盖缺口，
   而覆盖缺口和空断言在报告上长得一模一样：全绿。

   两条纪律：
   1. **不静默降级。** 遇到不支持的位深 / 色彩类型 / 隔行扫描，抛错，不返回一个
      “尽力而为”的位图。一个尽力而为的解码器会让后面每条像素断言变成近似。
   2. **CRC 真的校。** 它是这个解码器的负向孪生的根：改一个字节必须抛错。

   encodePng 是**夹具**，不是产品代码。它存在的唯一理由是让解码器的五种过滤器
   分支在离线快闸门里全部被跑到,否则那四条分支只有真截图碋到才会执行，
   而从没红过的分支和空断言是一个形状。 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let TABLE = null;
function crcTable() {
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    TABLE[n] = c;
  }
  return TABLE;
}

export function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG：签名不对');
  let off = 8;
  let ihdr = null;
  let sawIend = false;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new Error('PNG 截断了：' + type + ' 块超出文件长度');
    const data = buf.subarray(dataStart, dataEnd);
    const want = buf.readUInt32BE(dataEnd);
    const got = crc32(buf.subarray(off + 4, dataEnd));
    if (want !== got) throw new Error('PNG 的 ' + type + ' 块 CRC 不对');
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawIend = true;
    }
    off = dataEnd + 4;
  }
  if (!ihdr) throw new Error('PNG 没有 IHDR');
  if (!sawIend) throw new Error('PNG 没有 IEND');
  if (!idat.length) throw new Error('PNG 没有 IDAT');
  if (ihdr.bitDepth !== 8) throw new Error('只支持 8 位深，拿到 ' + ihdr.bitDepth);
  if (ihdr.colorType !== 2 && ihdr.colorType !== 6) throw new Error('只支持 RGB / RGBA，拿到 colorType ' + ihdr.colorType);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行扫描');

  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * ihdr.height) {
    throw new Error('解压后长度不对：拿到 ' + raw.length + '，按 IHDR 应为 ' + ((stride + 1) * ihdr.height));
  }

  const out = Buffer.alloc(ihdr.width * ihdr.height * 4);
  let prev = Buffer.alloc(stride);
  const filtersSeen = new Set();
  for (let y = 0; y < ihdr.height; y += 1) {
    const rowStart = y * (stride + 1);
    const f = raw[rowStart];
    filtersSeen.add(f);
    const cur = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (f === 0) continue;
      else if (f === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (f === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (f === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
      else throw new Error('未知的过滤器类型 ' + f + '（第 ' + y + ' 行）');
    }
    for (let x = 0; x < ihdr.width; x += 1) {
      const s = x * bpp;
      const d = (y * ihdr.width + x) * 4;
      out[d] = cur[s];
      out[d + 1] = cur[s + 1];
      out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return {
    width: ihdr.width,
    height: ihdr.height,
    colorType: ihdr.colorType,
    filtersSeen: Array.from(filtersSeen).sort(),
    data: out
  };
}

/* 比较器。只比内部矩形，因为 canvas 带 border-radius，元素截图的四个角会被裁掉。
   inset 与那个半径是一组耦合参数，浏览器闸门里有一条断言把两头钉在一起。
   返回第一个不同的坐标与两边的值，否则报告里只有一个“不相等”，定不了位。 */
export function comparePixels(a, b, width, height, inset) {
  if (a.length !== b.length) return { diff: -1, note: '两边长度不同：' + a.length + ' vs ' + b.length };
  let diff = 0;
  let first = null;
  let compared = 0;
  for (let y = inset; y < height - inset; y += 1) {
    for (let x = inset; x < width - inset; x += 1) {
      const i = (y * width + x) * 4;
      compared += 1;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
      diff += 1;
      if (!first) {
        first = {
          x: x,
          y: y,
          a: [a[i], a[i + 1], a[i + 2], a[i + 3]],
          b: [b[i], b[i + 1], b[i + 2], b[i + 3]]
        };
      }
    }
  }
  return { diff: diff, compared: compared, first: first };
}

export function distinctColors(rgba, width, height, inset) {
  const seen = new Set();
  for (let y = inset; y < height - inset; y += 1) {
    for (let x = inset; x < width - inset; x += 1) {
      const i = (y * width + x) * 4;
      seen.add((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]);
    }
  }
  return seen.size;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* 夹具。filterPerRow 让每一行用不同的过滤器，专门用来把解码器的五条分支全跑到。
   正向过滤是逆公式，filtered[i] = raw[i] - pred。 */
export function encodePng(width, height, rgba, filterPerRow) {
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const f = filterPerRow ? filterPerRow[y % filterPerRow.length] : 0;
    const line = Buffer.from(rgba.subarray(y * stride, (y + 1) * stride));
    const encoded = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) pred = paeth(a, b, c);
      encoded[i] = (line[i] - pred) & 0xff;
    }
    raw[y * (stride + 1)] = f;
    encoded.copy(raw, y * (stride + 1) + 1);
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
