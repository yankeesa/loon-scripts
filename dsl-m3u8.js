/**
 * dsl-m3u8.js v1 — 给 Apple 播放器字幕菜单增加「简体中文」轨
 *
 * 原理（同 DualSubs 字幕轨方案）：
 * 1. 拦截 master m3u8，把英文字幕轨复制一条新轨：NAME="简体中文"、LANGUAGE="zh"，
 *    URI 加 ?dslzh=1 标记 → 播放器右下角字幕菜单出现「简体中文」选项
 * 2. 拦截带 ?dslzh=1 的 media playlist（字幕轨的 m3u8），给其中每个 .webvtt
 *    分段 URL 也加上 dslzh=1 标记
 * 3. dsl-vtt.js 对带标记的 webvtt 做整段中文翻译 → 选中该轨即显示全中文
 */

const ZH_NAME = "简体中文";

function main() {
    const raw = (typeof $response !== "undefined" && $response.body) || "";
    if (!raw) { $done({}); return; }

    // master m3u8：含 EXT-X-MEDIA SUBTITLES 定义
    if (/EXT-X-MEDIA/.test(raw) && /TYPE=SUBTITLES/.test(raw)) {
        const out = addZhTrack(raw);
        console.log("[M3U8] master 播放列表，已加「" + ZH_NAME + "」轨: " + (out !== raw));
        $done({ body: out });
        return;
    }

    // media playlist：webvtt 分段列表，仅处理带 dslzh=1 标记的（简体中文轨）
    if (/\.webvtt/i.test(raw)) {
        if (!/[?&]dslzh=1/.test($request.url)) {
            console.log("[M3U8] 英文字幕轨 playlist，放行");
            $done({});
            return;
        }
        console.log("[M3U8] 简体中文轨 playlist，标记分段");
        $done({ body: markSegments(raw) });
        return;
    }

    $done({});
}

// 复制英文字幕轨为简体中文轨
function addZhTrack(raw) {
    const lines = raw.split("\n");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const out = [];
    let added = false;
    let enLine = null;

    lines.forEach(function (line) {
        out.push(line);
        if (added || !/^#EXT-X-MEDIA:TYPE=SUBTITLES/i.test(line)) return;
        // 已有中文名轨（官方中文）就不重复加
        if (line.indexOf(ZH_NAME) !== -1 || /LANGUAGE="(zh|cmn|yue)"/i.test(line)) return;
        if (!enLine) enLine = line;   // 记住第一条字幕轨（通常是英文）
    });

    if (enLine) {
        let zh = enLine
            .replace(/NAME="[^"]*"/i, 'NAME="' + ZH_NAME + '"')
            .replace(/LANGUAGE="[^"]*"/i, 'LANGUAGE="zh"')
            .replace(/DEFAULT=(YES|NO)/i, "DEFAULT=NO")
            .replace(/AUTOSELECT=(YES|NO)/i, "AUTOSELECT=NO")
            .replace(/FORCED=(YES|NO)/i, "FORCED=NO");
        // URI 加标记
        zh = zh.replace(/URI="([^"]*)"/i, function (m, uri) {
            return 'URI="' + uri + (uri.includes("?") ? "&" : "?") + "dslzh=1" + '"';
        });
        out.push(zh);
        added = true;
    }
    return out.join(eol);
}

// 给 media playlist 中的 webvtt 分段 URL 加 dslzh=1
function markSegments(raw) {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const lines = raw.split("\n").map(function (line) {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;
        if (!/\.webvtt/i.test(t)) return line;
        return line + (t.includes("?") ? "&" : "?") + "dslzh=1";
    });
    return lines.join(eol);
}

main();
