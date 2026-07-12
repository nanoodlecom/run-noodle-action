# run-noodle-action

**Run a saved [nanoodle](https://nanoodle.com) workflow in your CI pipeline.**
Design a graph visually in the nanoodle editor, commit the `noodle-graph.json`,
and this GitHub Action runs it against the [NanoGPT](https://nano-gpt.com) API —
generate the release jingle, the OG image, or the changelog art right from a
workflow.

Wraps the zero-dependency [`nanoodle` CLI](https://github.com/nanoodlecom/nanoodle-js)
(`npx nanoodle run`), pinned to an exact version.

> **This spends real money.** Every run bills your NanoGPT balance per
> generation. Trigger it from `workflow_dispatch` or a release tag — never on
> every push.

## Usage

```yaml
name: release art
on:
  workflow_dispatch:      # manual button — recommended (each run costs money)

jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: noodle
        uses: nanoodlecom/run-noodle-action@v1
        with:
          graph: art/noodle-graph.json
          api-key: ${{ secrets.NANOGPT_API_KEY }}
          inputs: |
            Text=release ${{ github.ref_name }} poster, bold, celebratory

      - uses: actions/upload-artifact@v4
        with:
          name: release-art
          path: ${{ steps.noodle.outputs.out-dir }}
```

See [.github/workflows/demo.yml](.github/workflows/demo.yml) for a runnable
example (workflow_dispatch only, for the same reason).

### Run straight from a share link

No file to commit — paste the link the editor's **Share** button gives you
into `graph:` and CI runs that pipeline. A full URL, a short link, or a bare
`#g=`/`#j=`/`#a=` fragment all work (needs `nanoodle-version >= 0.2.0`).

```yaml
      - id: noodle
        uses: nanoodlecom/run-noodle-action@v1
        with:
          graph: https://nanoodle.com/#g=H4sIAAAA...   # your share link
          api-key: ${{ secrets.NANOGPT_API_KEY }}
          inputs: |
            Text=release ${{ github.ref_name }} poster, bold, celebratory
```

Direct `#g=`/`#j=`/`#a=` links decode locally with no extra network hop;
da.gd/TinyURL short links are followed to find the underlying fragment.

### The flow

1. Design and test your workflow at [nanoodle.com](https://nanoodle.com) —
   pick your models there too.
2. Hit save; download `noodle-graph.json`.
3. Commit the JSON to your repo.
4. Point this action at it. `npx nanoodle inspect your-graph.json` (offline,
   free) shows the input and setting keys the graph accepts.

### Secrets setup

Add your NanoGPT API key as a repository secret named `NANOGPT_API_KEY`
(repo → Settings → Secrets and variables → Actions). Pass it via
`api-key: ${{ secrets.NANOGPT_API_KEY }}`. The action hands the key to the
CLI through an environment variable only — it never appears in the command
line or the logs.

## Inputs

| input | required | default | description |
|---|---|---|---|
| `graph` | yes | — | The graph to run — either a path to a saved `noodle-graph.json` in your repo, **or a nanoodle share link** (a full `https://` share URL, a da.gd/TinyURL short link, or a bare `#g=`/`#j=`/`#a=` fragment). Requires `nanoodle-version >= 0.2.0`. |
| `api-key` | yes | — | NanoGPT API key — pass `${{ secrets.NANOGPT_API_KEY }}`. |
| `inputs` | no | `""` | Workflow inputs, one `KEY=VALUE` per line. Blank lines and `#` comments are skipped. `@path` values read files, same as the CLI. |
| `set` | no | `""` | Setting overrides, one `node.setting=value` per line (e.g. `n3.model=flux-dev`). |
| `out-dir` | no | `nanoodle-out` | Where media outputs and the result JSON are written. |
| `timeout-ms` | no | — | Overall run timeout in milliseconds. |
| `nanoodle-version` | no | `0.2.0` | Exact CLI version to run — pinned, never floating. Share-link graphs need `>= 0.2.0`. |

## Outputs

| output | description |
|---|---|
| `out-dir` | Directory with saved media outputs plus `nanoodle-result.json`. |
| `cost-usd` | Total run cost in USD as reported by NanoGPT (a floor if any call omitted a price). |
| `result-json` | Path to the machine-readable result: outputs, cost, per-node statuses. |

Media outputs are saved into `out-dir` named after their output key
(`Image.jpg`, `Song.mp3`, ...). Text outputs appear in the result JSON.

## Limitations

- **Feed-forward DAGs only** — that is all nanoodle graphs are; there are no
  loops or agents.
- **Browser-only nodes are unsupported** (`resize`, `vframes`, `combine`,
  `soundtrack`, `trim`, `extractaudio`) — the CLI fails fast before spending
  anything if the graph contains one. See the
  [nanoodle-js docs](https://github.com/nanoodlecom/nanoodle-js#supported-nodes).
- **Graphs must have models set.** The editor writes the models you chose
  into the JSON when you save — pick models in the editor before downloading,
  or override with `set:` (e.g. `n3.model=flux-dev`).
- Each run spends NanoGPT balance; a failed run may still have spent on the
  nodes that completed (partial results and per-node costs are in the result
  JSON, and the step fails).

## Marketplace

Publishing to the GitHub Marketplace requires this repository to be public
plus a `v1` release/tag. The `v1` tag is pushed; the Marketplace listing
itself is a post-public step — not done yet.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT. Build workflows at
[nanoodle.com](https://nanoodle.com).
