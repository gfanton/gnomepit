// The links every footer carries to the game's code: its repository, and the realm the page
// plays on, on gnoweb.

// sourceLinksHTML links the repository, and realmName's page when it has one; page comes from
// realmPage, which only gives a realm path's own characters.
export function sourceLinksHTML(realmName: string, page: string | null): string {
  return `<span class="source-links"><a href="https://github.com/gfanton/gnomepit">Source on GitHub</a>${page !== null ? `<a href="${page}">${realmName} on gno.land</a>` : ""}</span>`;
}
