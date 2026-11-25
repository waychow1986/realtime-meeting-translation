/** The anchor properties the download uses. */
export interface DownloadLink {
  href: string;
  download: string;
  hidden: boolean | string;
  click(): void;
  remove(): void;
}

/** The part of `Document` the download needs (structural, so the module is testable without a DOM). */
export interface DownloadDocument<L extends DownloadLink> {
  createElement(tag: "a"): L;
  body: { appendChild(node: L): unknown };
}

/**
 * Saves text as a local UTF-8 file through a temporary blob link (TD-904): generated in the page, no request is
 * sent and nothing is written to browser storage.
 */
export function downloadText<L extends DownloadLink>(
  doc: DownloadDocument<L>,
  fileName: string,
  text: string,
): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = doc.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
