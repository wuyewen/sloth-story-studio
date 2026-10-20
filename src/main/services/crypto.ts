import { safeStorage } from "electron";

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function encryptKey(plain: string): string {
  if (!isEncryptionAvailable()) {
    return Buffer.from(plain, "utf-8").toString("base64");
  }
  return safeStorage.encryptString(plain).toString("base64");
}

export function decryptKey(b64: string): string {
  if (!b64) return "";
  if (!isEncryptionAvailable()) {
    return Buffer.from(b64, "base64").toString("utf-8");
  }
  try {
    return safeStorage.decryptString(Buffer.from(b64, "base64"));
  } catch {
    return "";
  }
}
