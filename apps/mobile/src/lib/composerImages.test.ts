import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as imagePicker from "expo-image-picker";

const files = new Map<string, { base64: string; deleted: boolean; size?: number | null }>();
const base64Reads = new Map<string, number>();

vi.mock("expo-file-system", () => ({
  FileMode: { ReadOnly: "readOnly" },
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    get size(): number | null {
      return files.get(this.uri)?.size ?? null;
    }

    open(): { readBytes: (length: number) => Uint8Array; close: () => void } {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return {
        readBytes: (length) =>
          Uint8Array.from(
            Buffer.from(entry.base64.slice(0, Math.ceil((length * 4) / 3)), "base64").subarray(
              0,
              length,
            ),
          ),
        close: () => undefined,
      };
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      base64Reads.set(this.uri, (base64Reads.get(this.uri) ?? 0) + 1);
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  },
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  pickComposerImages,
  toUploadChatImageAttachments,
} from "./composerImages";

const launchImageLibraryAsync = vi.mocked(imagePicker.launchImageLibraryAsync);

describe("picked image encoding", () => {
  beforeEach(() => {
    files.clear();
    base64Reads.clear();
    launchImageLibraryAsync.mockReset();
  });

  it("uses the picker JPEG when an adjusted PNG cache file cannot be read", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri: "file:///private/var/mobile/edited-screenshot.png",
          fileName: "edited-screenshot.png",
          mimeType: "image/png",
          base64: "/9j/AA==",
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result).toEqual({
      error: null,
      images: [
        expect.objectContaining({
          name: "edited-screenshot.jpg",
          mimeType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,/9j/AA==",
        }),
      ],
    });
  });

  it("does not Base64-encode an unsupported original when the picker supplied JPEG", async () => {
    const uri = "file:///private/var/mobile/photo.heic";
    files.set(uri, {
      base64: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]).toString(
        "base64",
      ),
      deleted: false,
      size: 12,
    });
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri,
          fileName: "photo.heic",
          mimeType: "image/heic",
          base64: "/9j/AA==",
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([
      expect.objectContaining({
        name: "photo.jpg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,/9j/AA==",
      }),
    ]);
    expect(base64Reads.get(uri) ?? 0).toBe(0);
    expect(result.error).toBeNull();
  });

  it("uses the encoded image type when adjusted asset metadata is absent", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri: "file:///private/var/mobile/edited-screenshot",
          fileName: null,
          mimeType: undefined,
          base64: "iVBORw0KGgoAAAANSUhEUg==",
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([
      expect.objectContaining({
        name: "image.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      }),
    ]);
    expect(result.error).toBeNull();
  });

  it("trusts readable original bytes over stale picker metadata", async () => {
    const uri = "file:///private/var/mobile/screenshot.png";
    files.set(uri, { base64: "iVBORw0KGgoAAAANSUhEUg==", deleted: false });
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri,
          fileName: "screenshot.gif",
          mimeType: "image/gif",
          base64: "/9j/AA==",
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([
      expect.objectContaining({
        name: "screenshot.png",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      }),
    ]);
    expect(result.error).toBeNull();
  });

  it("keeps the picker JPEG when a supported original exceeds the size limit", async () => {
    const uri = "file:///private/var/mobile/oversized-screenshot.png";
    files.set(uri, {
      base64: "iVBORw0KGgoAAAANSUhEUg==",
      deleted: false,
      size: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
    });
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri,
          fileName: "oversized-screenshot.png",
          mimeType: "image/png",
          base64: "/9j/AA==",
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([
      expect.objectContaining({
        name: "oversized-screenshot.jpg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,/9j/AA==",
      }),
    ]);
    expect(result.error).toBeNull();
  });

  it("keeps the picker JPEG when the original's reported size is too small", async () => {
    const uri = "file:///private/var/mobile/underreported-screenshot.png";
    const oversizedOriginal =
      "iVBORw0KGgo" + "A".repeat(Math.ceil(((PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1) * 4) / 3));
    files.set(uri, { base64: oversizedOriginal, deleted: false, size: 1 });
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri,
          fileName: "underreported-screenshot.png",
          mimeType: "image/png",
          base64: "/9j/AA==",
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([
      expect.objectContaining({
        name: "underreported-screenshot.jpg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,/9j/AA==",
      }),
    ]);
    expect(result.error).toBeNull();
  });

  it("rejects unrecognized bytes instead of trusting supported metadata", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri: "file:///private/var/mobile/not-really-a-screenshot.png",
          fileName: "not-really-a-screenshot.png",
          mimeType: "image/png",
          base64: "bm90IGFuIGltYWdl",
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([]);
    expect(result.error).toContain("not a supported image type");
  });

  it.each([
    ["incomplete GIF version", "R0lGODAA", "image/gif"],
    [
      "near-match RIFF marker",
      Buffer.from([0x52, 0x49, 0x46, 0x58, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).toString("base64"),
      "image/webp",
    ],
    [
      "near-match WebP marker",
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x58, 0x45, 0x42, 0x50]).toString("base64"),
      "image/webp",
    ],
  ])("rejects a %s", async (_case, base64, mimeType) => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          type: "image",
          uri: "file:///private/var/mobile/invalid-image",
          fileName: "invalid-image",
          mimeType,
          base64,
          width: 100,
          height: 100,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(result.images).toEqual([]);
    expect(result.error).toContain("not a supported image type");
  });
});

describe("toUploadChatImageAttachments", () => {
  it("strips client draft id and previewUri for the startTurn wire shape", () => {
    expect(
      toUploadChatImageAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/preview.png",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/t3-composer-paste/id.png")).toBe(false);
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });
});
