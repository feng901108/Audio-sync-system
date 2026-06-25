// 极简 multipart/form-data 解析器：把整个请求 body 读到内存，按 boundary 切片。
// 适合中等大小的音频上传（默认上限 200MB）。
export async function parseMultipart(req, boundary, maxBytes = 200 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error("上传超过限制");
    chunks.push(c);
  }
  const body = Buffer.concat(chunks);
  const dashBoundary = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(dashBoundary);
  if (pos < 0) return parts;
  pos += dashBoundary.length;
  while (true) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (headerEnd < 0) break;
    const headerBlock = body.subarray(pos, headerEnd).toString("utf8");
    const headers = {};
    for (const line of headerBlock.split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const cd = headers["content-disposition"] ?? "";
    const nameMatch = /name="([^"]*)"/.exec(cd);
    const fileMatch = /filename="([^"]*)"/.exec(cd);

    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(dashBoundary, dataStart);
    if (nextBoundary < 0) break;
    let dataEnd = nextBoundary;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const data = body.subarray(dataStart, dataEnd);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: fileMatch ? fileMatch[1] : null,
      contentType: headers["content-type"] ?? null,
      data,
    });

    pos = nextBoundary + dashBoundary.length;
  }
  return parts;
}
