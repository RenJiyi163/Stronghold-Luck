package com.strongholdluck.android

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipFile

/**
 * The game.
 *
 * The code ships inside the APK (the upstream **lite** package is staged into `assets/game/` by the
 * build), and only what is too big to carry is fetched on first run: the art, the audio and the fonts,
 * cut out of the upstream **full** package.
 *
 * It is cut out of the full package rather than downloaded file by file because that is the only shape
 * upstream offers that works here. Their `tools/setup.mjs` refuses to run below Node 22 with a hard
 * exit, and it kicks off the asset download by spawning a second node process — neither survives inside
 * an embedded libnode (which is Node 18 and has no child process to spawn). One zip over HTTP, unpacked
 * by Android's own ZipFile, is the version that does not depend on their tooling at all.
 */
object GamePack {
    private const val TAG = "GamePack"

    /** The upstream release this build was assembled against. Must match EXPECTED_GAME_VERSION in
     *  src/launcher.mjs and GAME_VERSION in android/scripts/stage-assets.sh. */
    const val GAME_VERSION = "0.2.6"

    private const val ZIP_NAME = "Stronghold-Protocol-v$GAME_VERSION.zip"
    private const val RELEASE = "https://github.com/sganggs/Stronghold-Protocol/releases/download/v$GAME_VERSION/$ZIP_NAME"
    /** The prefix proxy upstream documents for slow networks; tried first, falls back to GitHub. */
    private const val MIRROR = "https://gh-proxy.com/$RELEASE"

    /** Everything in the zip sits under this one folder (the release is packed from its parent). */
    private const val ROOT_IN_ZIP = "Stronghold-Protocol/"

    /**
     * What is taken out of the full package. The code is already in the APK and the download must not
     * overwrite it, so only the three big things are wanted: the art and audio tree, the fonts, and the
     * marker that says the official local-client assets (3D board, scenes) came with the package.
     */
    private val WANT = listOf("public/assets/", "public/fonts/", "data/local-assets.json")

    private const val CODE_MARK = ".code-ready"
    private const val ASSETS_MARK = ".assets-ready"

    fun gameDir(ctx: Context): File = File(ctx.filesDir, "game")
    fun zipFile(ctx: Context): File = File(ctx.cacheDir, ZIP_NAME)

    /**
     * The game is playable once its code is unpacked and the art the code expects is there. The two
     * marks carry the version they were written for, so a new APK (or a new game release) redoes the
     * half that changed instead of the whole thing.
     */
    fun isReady(ctx: Context): Boolean =
        File(gameDir(ctx), "server/index.js").isFile &&
            mark(ctx, CODE_MARK) == GAME_VERSION &&
            mark(ctx, ASSETS_MARK) == GAME_VERSION

    private fun mark(ctx: Context, name: String): String? =
        File(gameDir(ctx), name).takeIf { it.isFile }?.readText()?.trim()

    /**
     * Unpack the code that rode along in the APK. It is written over whatever is already there rather
     * than replacing the directory: on an update the art from the previous run is still good and must
     * not be thrown away with it.
     */
    fun stageCode(ctx: Context, log: (String) -> Unit) {
        val dest = gameDir(ctx)
        if (mark(ctx, CODE_MARK) == GAME_VERSION) return
        log("正在展开游戏文件（第一次会久一点）…")
        val n = Assets.copyTree(ctx, "game", dest) { done -> log("已展开 $done 个文件…") }
        File(dest, CODE_MARK).writeText(GAME_VERSION)
        log("游戏文件就绪（$n 个文件）。")
    }

    /** Downloaded size, for the progress line. */
    fun haveBytes(ctx: Context): Long = zipFile(ctx).takeIf { it.isFile }?.length() ?: 0L
    fun expectBytes(): Long = 583_440_026L

    /** Download the package, resuming a previous attempt. Tries the proxy first, then GitHub itself. */
    fun download(ctx: Context, log: (String) -> Unit) {
        val out = zipFile(ctx)
        var lastError: Exception? = null
        for (source in listOf(MIRROR to "镜像", RELEASE to "GitHub")) {
            try {
                fetch(source.first, out, source.second, log)
                return
            } catch (e: Exception) {
                lastError = e
                log("${source.second} 源没成功（${e.message}），换一个源继续。")
            }
        }
        throw IllegalStateException("两个下载源都没成功：${lastError?.message}")
    }

    private fun fetch(url: String, out: File, label: String, log: (String) -> Unit) {
        val from = if (out.isFile) out.length() else 0L
        log(if (from > 0) "继续下载游戏包（$label，已有 ${mb(from)}）…" else "开始下载游戏包（$label，约 ${mb(expectBytes())}）…")
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            if (from > 0) setRequestProperty("Range", "bytes=$from-")
        }
        try {
            val code = conn.responseCode
            if (code == 416) return // the file is already complete
            if (code != 200 && code != 206) throw IllegalStateException("HTTP $code")
            val resumed = code == 206 && from > 0
            val total = if (resumed) from + conn.contentLengthLong else conn.contentLengthLong
            conn.inputStream.use { input ->
                FileOutputStream(out, resumed).use { output ->
                    val buf = ByteArray(1 shl 16)
                    var done = if (resumed) from else 0L
                    var announced = done
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        done += n
                        if (done - announced >= (2L shl 20)) {
                            announced = done
                            log(if (total > 0) "已下载 ${mb(done)} / ${mb(total)}（${done * 100 / total}%）" else "已下载 ${mb(done)}")
                        }
                    }
                    log("下载完成：${mb(done)}")
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    /** Unpack the wanted parts of the package into the game directory. Safe to re-run. */
    fun extract(ctx: Context, log: (String) -> Unit) {
        val dest = gameDir(ctx)
        dest.mkdirs()
        var written = 0
        var bytes = 0L
        ZipFile(zipFile(ctx)).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                if (entry.isDirectory || !entry.name.startsWith(ROOT_IN_ZIP)) continue
                val rel = entry.name.substring(ROOT_IN_ZIP.length)
                if (WANT.none { rel.startsWith(it) }) continue
                val target = File(dest, rel)
                target.parentFile?.mkdirs()
                zip.getInputStream(entry).use { input ->
                    FileOutputStream(target).use { output -> input.copyTo(output, 1 shl 16) }
                }
                written++
                bytes += entry.size
                if (written % 400 == 0) log("已解出 $written 个素材文件（${mb(bytes)}）…")
            }
        }
        File(dest, ".assets-ready").writeText(GAME_VERSION)
        Log.i(TAG, "extracted $written files, ${mb(bytes)}")
        log("素材解压完成：$written 个文件，${mb(bytes)}。")
    }

    private fun mb(n: Long): String = "${n / 1048576} MB"
}
