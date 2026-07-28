declare module "yauzl" {
  import type { Readable } from "node:stream";

  export interface Entry {
    fileName: string;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    isEncrypted(): boolean;
  }

  export interface ZipFile {
    fileSize: number;
    readEntry(): void;
    close(): void;
    on(event: "entry", listener: (entry: Entry) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void;
  }

  export interface OpenOptions {
    autoClose?: boolean;
    lazyEntries?: boolean;
    strictFileNames?: boolean;
    validateEntrySizes?: boolean;
  }

  export function openPromise(filePath: string, options?: OpenOptions): Promise<ZipFile>;

  const yauzl: {
    openPromise: typeof openPromise;
  };
  export default yauzl;
}

declare module "yazl" {
  import type { Readable } from "node:stream";

  export interface AddOptions {
    mtime?: Date;
    mode?: number;
    compress?: boolean;
    compressionLevel?: number;
    forceDosTimestamp?: boolean;
    size?: number;
  }

  export class ZipFile {
    outputStream: Readable;
    on(event: "error", listener: (error: Error) => void): this;
    addBuffer(buffer: Buffer, metadataPath: string, options?: Omit<AddOptions, "size">): void;
    addFile(realPath: string, metadataPath: string, options?: AddOptions): void;
    addReadStreamLazy(metadataPath: string, options: AddOptions, getReadStream: (callback: (error: Error | null, stream?: Readable) => void) => void): void;
    end(): void;
  }

  const yazl: {
    ZipFile: typeof ZipFile;
  };
  export default yazl;
}
