import { createHash, randomBytes, X509Certificate } from "node:crypto";

export const MAX_CHUNK = 64 * 1024;
export const MAX_BUFFER = 1024 * 1024;
export const OPEN = 1,
  DATA = 2,
  CLOSE = 3;
export interface InternetInvite {
  relay: string;
  room: string;
  key: string;
  pin: string;
  certificate: string;
}
export interface DirectInvite {
  address: string;
  pin: string;
  certificate: string;
}
export function directInvitation(invite: DirectInvite) {
  return `${invite.address}/#cobble-direct=${Buffer.from(JSON.stringify({ pin: invite.pin, certificate: invite.certificate })).toString("base64url")}`;
}
export function parseDirectInvite(address: string): DirectInvite | null {
  const url = new URL(address);
  const prefix = "#cobble-direct=";
  if (!url.hash.startsWith(prefix)) return null;
  if (
    url.hash.length > 8192 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search
  )
    throw new Error("Invalid direct teammate invitation");
  const data = JSON.parse(
    Buffer.from(url.hash.slice(prefix.length), "base64url").toString("utf8"),
  );
  if (
    typeof data.pin !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.pin) ||
    typeof data.certificate !== "string" ||
    data.certificate.length > 4096 ||
    new X509Certificate(data.certificate).fingerprint256
      .replaceAll(":", "")
      .toLowerCase() !== data.pin
  )
    throw new Error("Invalid direct teammate certificate");
  return { address: url.origin, pin: data.pin, certificate: data.certificate };
}
export interface RoomKeys {
  secret: string;
  key: string;
  room: string;
}
export function roomId(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
export function newRoom(): RoomKeys {
  const secret = randomBytes(32).toString("hex");
  return { secret, key: randomBytes(32).toString("hex"), room: roomId(secret) };
}
export function relayOrigin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter the relay's HTTPS origin. Plain HTTP is allowed only on localhost for testing.",
    );
  return url.origin;
}
export function invitation(invite: InternetInvite): string {
  return `${relayOrigin(invite.relay)}/#cobble=${Buffer.from(JSON.stringify({ room: invite.room, key: invite.key, pin: invite.pin, certificate: invite.certificate })).toString("base64url")}`;
}
export function parseInvite(address: string): InternetInvite | null {
  const url = new URL(address);
  if (!url.hash.startsWith("#cobble=")) return null;
  if (url.hash.length > 8192) throw new Error("Invalid internet invitation");
  const data = JSON.parse(
    Buffer.from(url.hash.slice(8), "base64url").toString("utf8"),
  );
  if (
    ![data.room, data.key, data.pin].every(
      (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new Error("Invalid internet invitation");
  if (
    typeof data.certificate !== "string" ||
    data.certificate.length > 4096 ||
    new X509Certificate(data.certificate).fingerprint256
      .replaceAll(":", "")
      .toLowerCase() !== data.pin
  )
    throw new Error(
      "The invitation certificate does not match its fingerprint",
    );
  url.hash = "";
  return {
    relay: relayOrigin(url.href),
    room: data.room,
    key: data.key,
    pin: data.pin,
    certificate: data.certificate,
  };
}
export function socketUrl(
  relay: string,
  room: string,
  role: "host" | "client",
) {
  const url = new URL(`/v1/rooms/${room}/${role}`, relayOrigin(relay));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
export function frame(
  id: string,
  type: number,
  bytes = Buffer.alloc(0),
): Buffer {
  if (!/^[a-f0-9]{32}$/.test(id) || bytes.length > MAX_CHUNK)
    throw new Error("Invalid relay frame");
  return Buffer.concat([Buffer.from(id, "hex"), Buffer.from([type]), bytes]);
}
export function unframe(bytes: Buffer) {
  if (
    bytes.length < 17 ||
    bytes.length > MAX_CHUNK + 17 ||
    ![OPEN, DATA, CLOSE].includes(bytes[16])
  )
    throw new Error("Invalid relay frame");
  return {
    id: bytes.subarray(0, 16).toString("hex"),
    type: bytes[16],
    bytes: bytes.subarray(17),
  };
}
