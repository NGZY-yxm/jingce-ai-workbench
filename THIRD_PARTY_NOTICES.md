# License information

Jingce includes Marked 17.0.5 at `public/marked.js`, copied from the published
`marked/lib/marked.esm.js` distribution. Upstream: https://github.com/markedjs/marked.
The following license information is reproduced from Marked's `LICENSE.md`.

## Contribution License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## Marked

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Markdown

Copyright © 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.

## Skill Import Components

Jingce includes js-yaml 4.1.1 at `public/yaml.js`, from the upstream ESM
distribution: https://github.com/nodeca/js-yaml. Copyright (C) 2011-2015
by Vitaly Puzrin. License: MIT.

Jingce includes JSZip 3.10.1 at `public/jszip.js`, from the upstream browser
distribution: https://github.com/Stuk/jszip. JSZip offers MIT or GPLv3;
Jingce uses the MIT option. Copyright (c) 2009-2016 Stuart Knightley,
David Duponchel, Franz Buchinger, Antonio Afonso.

The JSZip browser bundle includes these MIT-licensed components:

- pako 1.0.11: https://github.com/nodeca/pako. Copyright (C) 2014-2017 by
  Vitaly Puzrin and Andrei Tuputcyn.
- lie: https://github.com/calvinmetcalf/lie. Copyright (c) 2014-2018
  Calvin Metcalf, Jordan Harband.
- immediate: https://github.com/calvinmetcalf/immediate. Copyright (c) 2012
  Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier.
- setImmediate: https://github.com/YuzuJS/setImmediate. Copyright (c) 2012
  Barnesandnoble.com, llc, Donavon West, and Domenic Denicola.

The following MIT license applies to each of the components above:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

### Pako Zlib Port

The pako compression implementation contains a JavaScript port of zlib,
copyright (C) 1995-2013 Jean-loup Gailly and Mark Adler and (C) 2014-2017
Vitaly Puzrin and Andrey Tupitsin. Its source notice is reproduced here:

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
# Blender 预演工具

Blender 由用户自行安装，本项目不随源码包分发 Blender。Blender 使用 GNU GPL，官方入口 https://www.blender.org/ 。本项目新增的场景生成器为独立代码。

本机助手首次启动从 PyPI 下载 imageio-ffmpeg 0.6.0 的 Windows x64 wheel，按 PyPI SHA256 校验后提取 FFmpeg；该运行包不进入源码分发。imageio-ffmpeg 使用 BSD-2-Clause，项目 https://github.com/imageio/imageio-ffmpeg ，wheel 保留在本机 bin/video-package 下的授权文件。FFmpeg 的具体许可由下载构建的启用功能决定，含 libx264 的构建适用 GPL；执行文件的许可和构建配置可通过 `ffmpeg -L`、`ffmpeg -buildconf` 检查，来源 https://ffmpeg.org/legal.html 。重新分发运行时请随包提供相应许可及来源要求；默认助手包仅分发源文件与安装脚本。
