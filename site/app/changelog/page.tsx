import { changelog } from "../../lib/changelog.ts";
import { RELEASES_URL } from "../../lib/release.ts";

export const metadata = {
  title: "Changelog — Qutty",
  description:
    "What changed in each Qutty release, from the first tiling terminal build to agent harness overlays, chat tiles and the voice companion.",
};

export default async function Changelog() {
  const entries = await changelog();
  return (
    <div class="wrap">
      <header class="page-head">
        <h1>Changelog</h1>
        <p>
          Every release of Qutty, newest first. Downloads for each version are on{" "}
          <a href={RELEASES_URL} rel="noopener">GitHub Releases</a>.
        </p>
      </header>
      <div class="with-toc">
        <nav class="toc" aria-label="Versions">
          <ul>
            {entries.map((e) => (
              <li key={e.id}>
                <a href={`#${e.id}`}>{e.version}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          {entries.map((e) => (
            <article class="release prose" id={e.id} key={e.id} aria-labelledby={`${e.id}-t`}>
              <h2 id={`${e.id}-t`}>
                <a href={`#${e.id}`}>{e.version}</a>
              </h2>
              {e.summary && <p class="summary">{e.summary}</p>}
              <div class="md" dangerouslySetInnerHTML={{ __html: e.html }} />
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
