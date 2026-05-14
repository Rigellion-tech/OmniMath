function splitBuffer(buffer, separator) {
  const chunks = [];
  let offset = 0;
  let index = buffer.indexOf(separator, offset);

  while (index !== -1) {
    chunks.push(buffer.subarray(offset, index));
    offset = index + separator.length;
    index = buffer.indexOf(separator, offset);
  }

  chunks.push(buffer.subarray(offset));
  return chunks;
}

function parseContentDisposition(value) {
  const fields = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawValue.length) continue;
    const key = rawKey.trim();
    const joinedValue = rawValue.join("=").trim();
    fields[key] = joinedValue.replace(/^"|"$/g, "");
  }
  return fields;
}

export function parseMultipartForm(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundaryValue = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundaryValue) {
    throw Object.assign(new Error("Missing multipart boundary."), { statusCode: 400 });
  }

  const boundary = Buffer.from(`--${boundaryValue}`);
  const fields = {};
  const files = {};

  for (const rawPart of splitBuffer(buffer, boundary)) {
    let part = rawPart;
    if (!part.length || part.equals(Buffer.from("--\r\n")) || part.equals(Buffer.from("--"))) continue;
    if (part.subarray(0, 2).equals(Buffer.from("\r\n"))) part = part.subarray(2);
    if (part.subarray(0, 2).equals(Buffer.from("--"))) continue;
    if (part.subarray(-2).equals(Buffer.from("\r\n"))) part = part.subarray(0, -2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);
    const headers = Object.fromEntries(
      headerText.split("\r\n").map((line) => {
        const separatorIndex = line.indexOf(":");
        return [
          line.slice(0, separatorIndex).trim().toLowerCase(),
          line.slice(separatorIndex + 1).trim(),
        ];
      })
    );

    const disposition = parseContentDisposition(headers["content-disposition"] || "");
    const name = disposition.name;
    if (!name) continue;

    if (disposition.filename) {
      files[name] = {
        filename: disposition.filename,
        contentType: headers["content-type"] || "application/octet-stream",
        buffer: content,
      };
    } else {
      fields[name] = content.toString("utf8");
    }
  }

  return { fields, files };
}
