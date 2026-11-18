import { Link, type ReactNode } from "denext";
import { JsonLd, Tile } from "../../components/ui.tsx";
import {
  type Arch,
  type Asset,
  findAsset,
  formatDate,
  formatSize,
  latestRelease,
  type Release,
} from "../../lib/release.ts";
import { softwareJsonLd } from "../../lib/site.ts";

export const metadata = {
  title: "Download Qutty for macOS and Linux",
  description:
    "Download Qutty, the tiling terminal for coding agents: signed and notarized .dmg files for Apple Silicon and Intel Macs, Homebrew, and AppImage, .deb and tarball packages for Linux on x86_64 and arm64.",
};

const ARCH_LABEL: Record<Arch, string> = { arm64: "arm64", x86_64: "x86_64" };

function FileRow({ label, asset }: { label: string; asset: Asset | undefined }) {
  if (!asset) return null;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        <a class="file" href={asset.url} rel="nofollow">{asset.name}</a>
      </td>
      <td class="size">{formatSize(asset.size)}</td>
      <td class="sum">
        <a href={asset.sha256Url} rel="nofollow">SHA-256</a>
      </td>
    </tr>
  );
}

function Files({ children }: { children: ReactNode }) {
  return (
    <table class="files">
      <thead>
        <tr>
          <th scope="col">For</th>
          <th scope="col">File</th>
          <th scope="col">Size</th>
          <th scope="col">Checksum</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Mac({ release }: { release: Release }) {
  return (
    <Tile title="dmg — ~/Downloads" id="macos" class="platform" labelledBy="macos-t" dot="green">
      <h2 id="macos-t">macOS</h2>
      <p class="sub">
        For Apple Silicon (<code>arm64</code>) and Intel (<code>x86_64</code>) Macs. Builds are
        signed with a Developer ID and notarized by Apple.
      </p>
      <Files>
        <FileRow label="Apple Silicon" asset={findAsset(release, "mac", "arm64", "dmg")} />
        <FileRow label="Intel" asset={findAsset(release, "mac", "x86_64", "dmg")} />
      </Files>
      <div class="grid-2 after-table">
        <div>
          <h3>With Homebrew</h3>
          <pre class="code">{`brew tap brainwires/tap
`}<span class="c"># Homebrew 7+ asks you to trust casks from other taps</span>{`
brew trust --cask brainwires/tap/qutty
brew install --cask brainwires/tap/qutty`}</pre>
          <p class="note">Each release updates the cask automatically.</p>
        </div>
        <div>
          <h3>From the .dmg</h3>
          <p>
            Download the file for your Mac's chip, open it and drag Qutty to Applications. Not sure
            which chip you have? Apple menu → About This Mac: “Chip: Apple M…” is Apple Silicon,
            “Processor: Intel…” is Intel.
          </p>
        </div>
      </div>
    </Tile>
  );
}

function Linux({ release }: { release: Release }) {
  const arches: Arch[] = ["x86_64", "arm64"];
  return (
    <Tile
      title="AppImage — ~/Downloads"
      id="linux"
      class="platform"
      labelledBy="linux-t"
      dot="green"
    >
      <h2 id="linux-t">Linux</h2>
      <p class="sub">
        An AppImage, a <code>.deb</code> and a tarball for <code>x86_64</code> and{" "}
        <code>arm64</code>. The window is WebKitGTK, so the machine needs{" "}
        <code>libwebkit2gtk-4.1-0</code> and <code>libgtk-3-0</code>{" "}
        (Ubuntu 22.04+, Debian 12+, Fedora's <code>webkit2gtk4.1</code>). The <code>.deb</code>{" "}
        installs them for you.
      </p>
      <Files>
        {arches.map((a) => (
          <>
            <FileRow
              label={`AppImage, ${ARCH_LABEL[a]}`}
              asset={findAsset(release, "linux", a, "AppImage")}
            />
            <FileRow
              label={`.deb, ${ARCH_LABEL[a]}`}
              asset={findAsset(release, "linux", a, "deb")}
            />
            <FileRow
              label={`Tarball, ${ARCH_LABEL[a]}`}
              asset={findAsset(release, "linux", a, "tar.gz")}
            />
          </>
        ))}
      </Files>
      <div class="grid-2 after-table">
        <div>
          <h3>Debian and Ubuntu</h3>
          <pre class="code">{`sudo apt install ./Qutty-${release.version}-x86_64.deb   `}<span class="c"># or -arm64.deb</span>{`
qutty`}</pre>
          <p class="note">
            The package puts Qutty in <code>/usr/lib/qutty</code>, links <code>/usr/bin/qutty</code>
            {" "}
            and adds a launcher and icon, listed with the terminal emulators.
          </p>
        </div>
        <div>
          <h3>Any distribution, with the AppImage</h3>
          <pre class="code">{`chmod +x Qutty-${release.version}-x86_64.AppImage
./Qutty-${release.version}-x86_64.AppImage`}</pre>
          <p class="note">
            It mounts itself with FUSE (<code>fusermount</code>, from the <code>fuse3</code>{" "}
            package, which most desktops have); without it, run it with{" "}
            <code>--appimage-extract-and-run</code>. The tarball holds the same app as a folder:
            unpack it and run <code>Qutty-x64/Qutty-x64</code> (or{" "}
            <code>Qutty-arm64/Qutty-arm64</code>).
          </p>
        </div>
      </div>
    </Tile>
  );
}

export default async function Download() {
  const release = await latestRelease();
  const published = formatDate(release.publishedAt);
  return (
    <div class="wrap">
      <JsonLd json={softwareJsonLd(release, release.url)} />
      <header class="page-head">
        <h1>Download Qutty</h1>
        <p>
          Version {release.version}
          {published ? `, released ${published}` : ""}. Free and open source under the MIT license.
          {" "}
          <Link href="/changelog">What's new</Link>, or{" "}
          <a href={release.url} rel="noopener">the release on GitHub</a>.
        </p>
      </header>
      <div class="platforms">
        <Mac release={release} />
        <Linux release={release} />
        <Tile title="sha256sum — ~/Downloads" class="platform" labelledBy="verify-t">
          <h2 id="verify-t">Check a download</h2>
          <p class="sub">
            Every file has a <code>.sha256</code>{" "}
            beside it. Download both into the same folder and run:
          </p>
          <pre class="code">{`shasum -a 256 -c Qutty-${release.version}-arm64.dmg.sha256   `}<span class="c"># macOS</span>{`
sha256sum -c Qutty-${release.version}-x86_64.AppImage.sha256   `}<span class="c"># Linux</span></pre>
          <p class="note">
            Windows isn't supported yet. Qutty also runs from source on macOS and Linux; see the
            {" "}
            <a href="https://github.com/Brainwires/qutty#development" rel="noopener">README</a>.
          </p>
        </Tile>
      </div>
    </div>
  );
}
