# Companion looks

Qutty's companion comes with one look, **Loopy**, the steel bead with the big
eyes. You can give it a different look: a folder of pictures, one per mood. No
programming is needed, only a drawing program.

## Make a look in five steps

1. **Open the looks folder.** Settings → Companion → Look → **Open looks
   folder**. Qutty makes the folder if it isn't there yet:
   - macOS: `~/Library/Application Support/org.qutty.Qutty/companions`
   - Linux: `~/.local/share/org.qutty.Qutty/companions` (or
     `$XDG_DATA_HOME/org.qutty.Qutty/companions` when `XDG_DATA_HOME` is set)
2. **Copy the template.** Click **Create a look…**. Qutty copies a starter look
   into a new folder, `my-look`, and opens it. In it are `look.json`, a
   placeholder `idle.svg` and a `README.md` listing every picture a look can
   have.
3. **Draw `idle.png`.** Draw your companion resting and save it in that folder
   as `idle.png` (SVG, WebP and GIF work too). Delete the placeholder
   `idle.svg`. Then open `look.json` in a text editor and change `"name"` (and
   `"author"`).
4. **Reload.** Back in Settings → Companion → Look, click **Reload looks**.
5. **Pick it.** Your look now shows beside Loopy, with its `idle` picture as the
   thumbnail. Click it.

That's a complete look. The companion pops in, bobs, hops, nods off and folds
away with your picture, just as Loopy does. Add more pictures whenever you like
and click **Reload looks** again.

## The pictures

Name each picture after what it shows. Only `idle` is required. When a picture
is missing, the companion uses the one in the **Falls back to** column, then
that one's fallback, and so on until `idle`.

| File name   | When it shows                                         | Falls back to |
| ----------- | ----------------------------------------------------- | ------------- |
| `idle`      | Resting, nothing going on                             | (required)    |
| `happy`     | Glad: a job went well, something nice was said        | `idle`        |
| `sad`       | Something failed, or bad news                         | `idle`        |
| `surprised` | Caught off guard: something new needs a look          | `idle`        |
| `thinking`  | Working on an answer (also while it thinks in a chat) | `idle`        |
| `sleepy`    | Drowsy, late at night                                 | `idle`        |
| `neutral`   | A plain message                                       | `idle`        |
| `attention` | Pointing at a question that wants an answer           | `surprised`   |
| `success`   | Done, and it worked                                   | `happy`       |
| `confused`  | Puzzled                                               | `thinking`    |
| `mad`       | Annoyed                                               | `sad`         |
| `excited`   | Thrilled                                              | `happy`       |
| `love`      | Fond: hearts                                          | `happy`       |
| `shocked`   | Startled: something went badly wrong                  | `surprised`   |
| `wow`       | Amazed                                                | `surprised`   |
| `blush`     | Flattered and a little shy                            | `happy`       |
| `hot`       | The computer has been busy for a while                | `idle`        |
| `sleeping`  | Asleep at night                                       | `sleepy`      |
| `blink`     | Eyes shut for a blink (only on the idle picture)      | `idle`        |
| `listening` | Listening to you speak                                | `idle`        |
| `speaking`  | Talking, when there are no `speak-N` frames           | `idle`        |

So six pictures (`idle`, `happy`, `sad`, `surprised`, `thinking`, `sleepy`)
already cover every mood. A good order to draw them in is the order of the
table.

`listening`, `thinking` and `speaking` also cover the voice turn: when the look
has no `listening` picture, the companion keeps the mood's picture and swells
gently with your voice instead.

## Talking

While the companion talks, it opens and closes its mouth. Give it mouth frames
to do that with your drawing: `speak-0.png`, `speak-1.png`, `speak-2.png` and so
on (up to `speak-15`). Make `speak-0` the mouth closed and the last one wide
open. Qutty picks the frame for how loud each syllable is, so two or three
frames are plenty. Numbering must start at 0 with no gaps.

With fewer than two frames the companion bobs gently while it talks instead
(using `speaking` when you drew one).

## look.json

```json
{
  "id": "my-look",
  "name": "My look",
  "author": "You",
  "version": "1.0",
  "description": "A look of my own.",
  "size": { "w": 120, "h": 120 }
}
```

- `id`: lower-case letters, digits and dashes. Two looks can't share one, and
  `loopy` is taken.
- `name` is required; `author`, `version` and `description` show when you hover
  over the look in Settings.
- `size` is optional: how big the companion is drawn, in pixels, from 48 to 240
  on each side. Without it a look is drawn the size of Loopy (93 × 111).

## look.css (optional)

A `look.css` in the folder can restyle the companion while the look is on, such
as its speech bubble's colours:

```css
.bubble {
  border-color: #2a5f7a;
}
```

Qutty wraps the file in `[data-look="<id>"] { … }`, so its rules only reach the
companion. It removes `@import`, and every `url()` that isn't one of the look's
own pictures (`url(idle.png)` works; web addresses, `file:` and `../` paths
become `none`). A file with a stray `}`, a `\` escape outside a string, or a
script hook (`expression()`, `behavior:`, `javascript:`) is refused, and the
look stays out of the list with the reason.

## Limits

- Pictures: SVG, PNG, WebP or GIF, at most 1 MB each and 8 MB together, at most
  48 per look. Their contents must match their extension.
- No scripts. Pictures are drawn as images, so an SVG's scripts never run, and
  an SVG with a `<script>` is refused.
- Only the folder's own files are read: sub-folders, links (aliases) and files
  with other names are ignored. `look.json` at most 16 KB, `look.css` at most 32
  KB.
- At most 64 looks are listed.

A folder that isn't a usable look is listed under **Not usable** in Settings,
with why. If the look you picked goes missing or breaks, the companion goes back
to Loopy and Settings says so.

## An example

`tests/fixtures/looks/pixel-blob` in Qutty's source is a small example look,
Pixel Blob: the six base pictures, three mouth frames, a `size` and a
`look.css`. Copy the folder into your looks folder to try it. (It's used by
Qutty's tests and isn't built in.)
