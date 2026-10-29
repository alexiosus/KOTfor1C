# Third-Party Software Licenses

This software incorporates components from the following third-party software.

## 1c-neurofish onec-client-mcp-devkit

- **Authors/project:** [1c-neurofish and contributors](https://github.com/1c-neurofish/onec-client-mcp-devkit).
- **Version:** `v0.6.6`, upstream commit `8d7fe150f9d6ac7385266acf438d7aebc2215c0c`.
- **License:** GNU Lesser General Public License, version 3. The upstream license is preserved in [COPYING.LESSER](third-party/onec-client-mcp-devkit/COPYING.LESSER), alongside the [GNU GPL v3 text](third-party/onec-client-mcp-devkit/COPYING) which it incorporates.
- **Corresponding source:** the unmodified [upstream release source archive](third-party/onec-client-mcp-devkit/source-v0.6.6.tar.gz), also available at the [versioned upstream source](https://github.com/1c-neurofish/onec-client-mcp-devkit/tree/v0.6.6).
- **Source archive SHA-256:** `1b698bb7a616bea36c27dc573892f36739df6e3dbf89a4735b4618e325803e04`.
- **Component:** official `client_mcp.cfe`, SHA-256 `eaf065440a32a60eaa07c78fe7ed39c6b2c331db915e91328391af07364422fe`. KOT does not modify the extension's source. A prepared service DT can contain this extension as a separate 1C configuration extension.
- **Replacement/rebuilding:** see the [startup-template build instructions](docs/DEVELOPMENT.md#bundled-startup-template). The extension can be replaced through 1C Designer independently of KOT's TypeScript code. KOT verifies its supported version before enabling managed preparation; external MCP Attach uses capability negotiation.

### WebTransport included by devkit

The upstream devkit embeds `AddIn.WebTransport.mcp`, authored by [alkoleft / web-transport-addin](https://github.com/alkoleft/web-transport-addin). Its `Template.addin` contains WebTransport `0.6.4` binaries for Windows, Linux and macOS. They are retained unchanged in the upstream source archive.

The checked WebTransport repository has no `LICENSE` file or Cargo `license` field.

## Microsoft Visual Studio Code Codicons

This project vendors selected assets from `@vscode/codicons` version `0.0.44`.

- **Included files:** `media/codicon.css`, `media/codicon.ttf`
- **Source package:** https://www.npmjs.com/package/@vscode/codicons
- **Source repository:** https://github.com/microsoft/vscode-codicons

Upstream publishes mixed legal notices for this package:

- Repository legal notices state that code is licensed under the MIT License.
- The npm package metadata for `@vscode/codicons` `0.0.44` declares `CC-BY-4.0`.

This repository copies the upstream `dist/codicon.css` and `dist/codicon.ttf` files without modification and provides attribution here for the included Codicons assets.

### MIT-licensed Codicons CSS

The file `media/codicon.css` is copied from the upstream Codicons distribution and retains the upstream MIT license header.

    MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

### Codicons font attribution

The file `media/codicon.ttf` is distributed with attribution to Microsoft under the package's published `CC-BY-4.0` notice.

- **Copyright:** (c) Microsoft Corporation
- **License:** Creative Commons Attribution 4.0 International
- **License URL:** https://creativecommons.org/licenses/by/4.0/
- **Changes:** None. The file is copied verbatim from the upstream package.
