export const NORA_ARCHIVE_FORMAT = "nora";
export const NORA_ARCHIVE_FORMAT_VERSION = 1;

export const MANIFEST_PATH = "manifest.json";
export const DOCUMENT_PATH = "document.json";
export const RUNS_PREFIX = "runs/";
export const ASSETS_PREFIX = "assets/";

export const ASSET_BYTES_LIMIT = 100 * 1024 * 1024;
export const ARCHIVE_UNCOMPRESSED_BYTES_LIMIT = 1024 * 1024 * 1024;
export const ARCHIVE_ZIP_BYTES_LIMIT = 1024 * 1024 * 1024;

export const ARCHIVE_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
export const ARCHIVE_FILE_MODE = 0o100600;
export const STRUCTURED_MEDIA_TYPE = "application/json";
export const JSONL_MEDIA_TYPE = "application/x-ndjson";
export const ASSET_MEDIA_TYPE = "application/octet-stream";

export const NORA_TEMP_PREFIX = "nora-archive-";

export const HEX_SHA256_RE = /^[a-f0-9]{64}$/;
