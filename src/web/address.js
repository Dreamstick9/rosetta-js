import { lookup } from "node:dns/promises";
import net from "node:net";

const PRIVATE_V4_RANGES = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
];
const PRIVATE_V6_PREFIXES = ["fc", "fd", "fe8", "fe9", "fea", "feb", "ff"];

export async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw blocked(host);
  const addresses = net.isIP(host) ? [host] : await resolveAll(host);
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw blocked(host);
  }
}

async function resolveAll(host) {
  try {
    const records = await lookup(host, { all: true });
    return records.map((record) => record.address);
  } catch {
    throw new Error(`cannot resolve host ${host}`);
  }
}

function blocked(host) {
  return new Error(`blocked: ${host} is a private or loopback address`);
}

function isPrivateAddress(address) {
  const mapped = readMappedV4(address);
  if (mapped) return isPrivateAddress(mapped);
  if (net.isIPv4(address)) return PRIVATE_V4_RANGES.some(([base, bits]) => inRange(address, base, bits));
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  return PRIVATE_V6_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function readMappedV4(address) {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function inRange(address, base, bits) {
  const mask = (~0 << (32 - bits)) >>> 0;
  return (toNumber(address) & mask) >>> 0 === (toNumber(base) & mask) >>> 0;
}

function toNumber(address) {
  return address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}
