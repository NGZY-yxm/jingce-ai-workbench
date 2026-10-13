import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
// File paths are passed as environment values, never interpolated into PowerShell code.
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class JingceThumbnail {
    [StructLayout(LayoutKind.Sequential)] struct Size { public int Width, Height; }
    [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ImageFactory {
        [PreserveSig] int GetImage(Size size, uint flags, out IntPtr bitmap);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHCreateItemFromParsingName(string filename, IntPtr context, ref Guid iid, out ImageFactory factory);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);

    static Image Decode(string source, int edge) {
        try {
            var image = Image.FromFile(source);
            if (Array.IndexOf(image.PropertyIdList, 274) >= 0) {
                int orientation = BitConverter.ToUInt16(image.GetPropertyItem(274).Value, 0);
                var turns = new[] { RotateFlipType.RotateNoneFlipNone, RotateFlipType.RotateNoneFlipNone,
                    RotateFlipType.RotateNoneFlipX, RotateFlipType.Rotate180FlipNone, RotateFlipType.Rotate180FlipX,
                    RotateFlipType.Rotate90FlipX, RotateFlipType.Rotate90FlipNone, RotateFlipType.Rotate270FlipX,
                    RotateFlipType.Rotate270FlipNone };
                if (orientation >= 1 && orientation <= 8) image.RotateFlip(turns[orientation]);
            }
            return image;
        } catch (ArgumentException) {} catch (OutOfMemoryException) {}
        // Windows provides MP4/WebP thumbnails through its installed media codecs.
        ImageFactory factory = null; IntPtr handle = IntPtr.Zero;
        try {
            Guid iid = typeof(ImageFactory).GUID;
            Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(source, IntPtr.Zero, ref iid, out factory));
            // THUMBNAILONLY excludes generic file icons; BIGGERSIZEOK preserves aspect ratio.
            Marshal.ThrowExceptionForHR(factory.GetImage(new Size { Width = edge, Height = edge }, 9, out handle));
            return Image.FromHbitmap(handle);
        } finally {
            if (handle != IntPtr.Zero) DeleteObject(handle);
            if (factory != null) Marshal.ReleaseComObject(factory);
        }
    }
    public static void Create(string source, string destination, int edge) {
        using (var image = Decode(source, edge)) {
            double scale = Math.Min(1.0, Math.Min((double)edge / image.Width, (double)edge / image.Height));
            int width = Math.Max(1, (int)Math.Round(image.Width * scale));
            int height = Math.Max(1, (int)Math.Round(image.Height * scale));
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
                using (var graphics = Graphics.FromImage(bitmap)) {
                    graphics.CompositingMode = CompositingMode.SourceCopy;
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    using (var attributes = new ImageAttributes()) {
                        attributes.SetWrapMode(WrapMode.TileFlipXY);
                        graphics.DrawImage(image, new Rectangle(0, 0, width, height), 0, 0, image.Width, image.Height,
                            GraphicsUnit.Pixel, attributes);
                    }
                }
                bitmap.Save(destination, ImageFormat.Png);
            }
        }
    }
}
'@ -ReferencedAssemblies System.Drawing
[JingceThumbnail]::Create($env:JINGCE_THUMBNAIL_SOURCE, $env:JINGCE_THUMBNAIL_DESTINATION, [int]$env:JINGCE_THUMBNAIL_EDGE)
`;

export async function createWindowsThumbnail(source, destination, edge) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024,
    env: { ...process.env, JINGCE_THUMBNAIL_SOURCE: source, JINGCE_THUMBNAIL_DESTINATION: destination, JINGCE_THUMBNAIL_EDGE: String(edge) },
  });
}
