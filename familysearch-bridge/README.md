# FamilySearch bridge

This is the part of Family Faces that talks to FamilySearch. It is a small local
[MCP](https://modelcontextprotocol.io/) server that signs in with your own browser session, so
there is no API key and your sign-in never passes through the Python app.

I built it on Jonathan Reiss's MIT-licensed
[familysearch-mcp](https://github.com/JonathanReiss15/familysearch-mcp), which handles browser
sign-in and reads the Family Tree. I added Memories downloads, reading and writing face tags, and
tagged photo uploads, plus the scripts below that Family Faces calls.

## Set it up

You need Node.js 22 or newer and Google Chrome or Brave.

```bash
cd familysearch-bridge
npm install
npm run build
npm run login
```

`npm run login` opens your browser so you can sign in to FamilySearch. The session is saved to
`~/.familysearch-mcp/config.json`, readable only by you and never inside this repository. Once
`build/` exists, Family Faces finds the bridge on its own and turns on its FamilySearch features.
You can also sign in later from the app with **Connect FamilySearch**.

## Both directions

| Direction | Script | What it does |
| --- | --- | --- |
| In | `scripts/sync.mjs ROOT_ID CACHE_DIR tree` | Reads the tree around a person, four generations up and back down. |
| In | `scripts/sync.mjs ROOT_ID CACHE_DIR memories`, then `download` | Lists and downloads the photo Memories attached to those people. |
| In | `scripts/read-tags.mjs DATA_DIR LIBRARY_DIR` | Reads who is tagged in each downloaded Memory, with their tree IDs and face boxes. |
| Out | `scripts/upload.mjs` | Uploads a photo as a new Memory with the faces you named tagged, or adds tags to an existing one. |
| Both | `scripts/connection.mjs` | Checks the saved session, or opens the browser to sign in again. |

After a tree sync, `python -m family_faces.familysearch.importer CACHE_DIR` previews what
would change and `--apply` merges it, with a backup first. After reading tags, run
`python -m family_faces.familysearch.map_tags` while the app is open to turn the tags into named
faces. The app calls `upload.mjs` and `connection.mjs` itself from the upload dialog and never
uploads anything you have not previewed and chosen.

## Tests

```bash
npm test
```

## Using it on its own

`build/index.js` is a standard stdio MCP server, so you can also add it to any MCP client:

```json
{ "mcpServers": { "familysearch": { "command": "node", "args": ["/path/to/familysearch-bridge/build/index.js"] } } }
```
