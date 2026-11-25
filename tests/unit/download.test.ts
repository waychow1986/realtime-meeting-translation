import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadText, type DownloadDocument } from "../../src/web/download.js";

interface FakeAnchor {
  href: string;
  download: string;
  hidden: boolean;
  clicked: number;
  removed: boolean;
  click(): void;
  remove(): void;
}

function fakeDocument(): {
  doc: DownloadDocument<FakeAnchor>;
  anchors: FakeAnchor[];
  appended: unknown[];
} {
  const anchors: FakeAnchor[] = [];
  const appended: unknown[] = [];
  const doc: DownloadDocument<FakeAnchor> = {
    createElement(tag: string) {
      expect(tag).toBe("a");
      const anchor: FakeAnchor = {
        href: "",
        download: "",
        hidden: false,
        clicked: 0,
        removed: false,
        click() {
          this.clicked += 1;
        },
        remove() {
          this.removed = true;
        },
      };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: (node: unknown) => appended.push(node) },
  };
  return { doc, anchors, appended };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("downloadText", () => {
  it("clicks a temporary download link to a UTF-8 text blob, removes it and revokes the URL afterwards", async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:test/1";
    });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const { doc, anchors, appended } = fakeDocument();

    downloadText(
      doc,
      "字幕-20261125-160210.txt",
      "导出日期：2026-11-25\n\n14:05:32 含😀\n",
    );

    expect(anchors).toHaveLength(1);
    const [anchor] = anchors;
    expect(anchor).toMatchObject({
      href: "blob:test/1",
      download: "字幕-20261125-160210.txt",
      clicked: 1,
      removed: true,
    });
    expect(appended).toEqual([anchor]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe("text/plain;charset=utf-8");
    const bytes = new Uint8Array(await blobs[0]!.arrayBuffer());
    expect(bytes[0]).not.toBe(0xef);
    expect(new TextDecoder().decode(bytes)).toBe(
      "导出日期：2026-11-25\n\n14:05:32 含😀\n",
    );
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:test/1");
  });
});
