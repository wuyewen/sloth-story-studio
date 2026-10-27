import { app, Menu, nativeImage, Tray } from "electron";
import { openConfigWindow, openMainWindow } from "./windows.js";

let tray: Tray | null = null;
let isQuitting = false;

export function getIsQuitting(): boolean {
  return isQuitting;
}


export function createTray(): Tray {
  if (tray) return tray;

  const image = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEqADAAQAAAABAAAAEgAAAACaqbJVAAAB7UlEQVQ4Ea3TMUhWURiAYevXSkG0+IskSSlFSRCEhsQ0XBJMkGgpgtBRCR0UW3IwBwcRCYxwaGpqSCLCSMPERIXCGhpKFHNRp0qUtATzfQ/9N0GQBj94OOeee+6533fOvUlJ+xQH9ljnIvcqcAo/MIZhbOG/4jSznuPPDuv01zCEXBgnUYmQTLIjOyJO/xlKsIQHmIURgw+b5QIKcAOj2BXdjJjJOMrQh29wbAPv0YiDMNKQj5CVA4VIx1ss4zym4AJm2IpyXEAHGmD4jPeiyka5eId61OIRXKQFRbAkw0Um8AbZiMIUXe0YzOIm5nALH2C4wV24jjV43z20iihcJAWpf0dWac3I8cNowwv0wjJe4Ttew33x/gKeIEz4SmspTTBt+3JCYmPphhIf0roN7XBOD6JN8mg9bpUiETV03PR5WL4l+U1dxRVYQagmsduW8RhVsG/4/dzFGZyDm76JZpzAAD7DxUPav2n9BRy8DMNP4A6Ow+9pBnWohi/Iw30cxReEhX7RetN6/cCMDPjmLHjc9/AUcXTCRTxln/2I8NnbHsFZrMASPMkclGMMMfh2j/42jEH0wyS2nGB8QjEm4S9hZj/h+EtcwzQy4Tx/FRcMi9D++0e8INzYRVjmIXgqHogPO3YJPjwCX7T/sQ0lPnLANoBwfQAAAABJRU5ErkJggg==");
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAJKADAAQAAAABAAAAJAAAAAAqDuP8AAAFQUlEQVRYCe2Va7DVUxTA60YPItHkVblcKdVE6aEZdEtExIjC+KDGK2EQfcCYapoxapBPxvQwo5fH1CB50208Jt2GlEQxUlIeozDVLYTf78xZ9+7zd865GdO31szvrLXXXvvx32vtfZo0OSjlT6Bp+e6SvVX09IUucAJUwC5YCx/DatgHB1yGscJi+AX+LsEe/DUwAg6YdGTm56HUJkr55zDmmBK76o3fef+zdGfEZ1Bq0b30bYaV8Aosh02g3zHL4AhI5UwaH8ICOC7taMzuQMA6KLaZWvzjoQe0hFRsd4UJ4PhJkNbr1bStufXgSdVLGlTvzBvN0QtheKZjC+0pMCPvH4geDN2gGbj5jeAJvAF1UA2enJsIuRdjFbwTjsb0lQRkT+YDfJ3zA69Dm6ZsTNp28/dD9gRx5TZf7kCMqZcKrNcgnbyG9tFwOMzP9KVxUTvett/ycZ5EfAhmgfShNRVaF3gzDd8ZjzoW+gbbG+EgCzf8obfh+xyeAgt2KPSCTnAxvAcb4BRIxRN6CExlv7TDE3GXE8CqbwXeABf8C64BZTbEJtQ/wu3g4+iYYtIWZxt4AfwY6yyV9jSuSh3aXstvwUW+BgMc+DIsBcWaSTfzHe0BdpQQN/kq7IAVMA68VdXQqJiOnyEW/B17LLQD36EjwSNP++P2DcI/He6D9BH0o4xfA27K130jGNuo9CHiD4gF1TuhPyhjIO17k7b5n5bxT6Z9IkyEm+BtmAtx+s5h2kqKtaO0gENyVsOPt2lYvjm6wZ2znuP3TrDmPoVFsAy2QyVcAD+BaTblbnwWWI+VUOwZwN0gAzHTEwh7CH5vxu5MvxvZnPd9iZ4PLuqz4G05Fy6DwyDkKAzTtgri40/Dfgy6QIGMohWbCP0DPmvn1iJ9puxPMM3PwOUQi5yKXQ3HQyoxz7y88wr0VnC9kXlfvfJax0ZCe8MUcx6+VPvo3WDAfsi1xMQj6eb7gjUa803CLpBiG3ISCzQmisGh19FXVTDLvxum5AnwNB33FjTP65hHbbpzEscc7dDWhyd0M/hGFZPTcdbCi/Au+FKbQj/CPuvoHPBhVHzfvHk+B0MglTZpQzt7Qr4pfomLpF9SzvYUfL+KxSzH3xUU37XzYQFE7AzsnFSEkejvsQ2w0GOSpDtnen1dZCxsBdvN4FDIylc4RsAX0Bt6grfvepgOjvX25SRS5iMX8hKGr/a4cGS0X3UXzII6sOjbwcngQ+rX9wHFOrsUOsEjYEq9oevz9ni0Y1pBgfg3EMfn+9EDHBy+VO/C3x5uhJngKVkvPhEhF2LUgNq+R6EXKNbYHTAbPKklMBEKZAAtF90Nfs1t+Xa6ETf4OFwEylTYCRFj6hbBSIhSMAPx6J2B/TRsB8dYny1hBXgIBVJJy+v9K/gH+QDEQqHN9Ufg150N3oxjYRq42YhT10Js3HRMgXTzxswF/55WgukukBa01kAduIi5TRfI2t6oDTAZPPZbYB+kcT4Hbvr9jD9ixuDvD3OgqDyM1+BBYKAnEoPL6YXENYWlmfjRtAdnfDGPmegA1qHlUlSq8Hr95uV7X0fHBOX0XuI6gmmJONNzEnitw5fqZ/FbX/6FlBWP3nR4Shb3J5BOVMzeRkxr8O2KftNkwRYb70fHjcNsXO4mZC30g7bgl9u2vmJB9R6wIIdDd9gB0f8gdmfIjtmEz/iSYu6LyVk4R4FfuAQsWFNqarzS1tcW8IEzZUPBhXpCN7gEzgNvoLG+0ovhSXBTJaXUhmKAG3AzvjH7I27WYjX+HmgOS2E1WFcH5X+fwD+XkPavdhRphQAAAABJRU5ErkJggg==", "base64") });

  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Sloth Story Studio");

  const menu = Menu.buildFromTemplate([
    { label: "打开主窗口", click: () => openMainWindow() },
    { label: "大模型配置", click: () => openConfigWindow("models") },
    { label: "系统设置", click: () => openConfigWindow("settings") },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => openMainWindow());

  return tray;
}
