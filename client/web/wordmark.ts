// wordmarkHTML is the masthead's link home: the game's name, its beta tag and its tagline.
// attributes go on the link as given, so they must be trusted markup.
export function wordmarkHTML(href: string, attributes = ""): string {
  return `<a class="wordmark" href="${href}"${attributes === "" ? "" : ` ${attributes}`}>Gnomepit<span class="wordmark__beta">Beta</span><span>UNDER THE MOUNTAIN</span></a>`;
}
