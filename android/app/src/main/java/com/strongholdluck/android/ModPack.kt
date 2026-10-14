package com.strongholdluck.android

import android.content.Context
import java.io.File

/**
 * The mod itself lives in the APK (`assets/mod/` — this repo's `src/` and `public/`) and is unpacked into
 * the app's private directory on first run, because Node cannot read a file out of an APK.
 */
object ModPack {
    private const val MARK = ".staged-version"

    /** Bumped by hand whenever the shipped mod changes; a new value re-unpacks on the next launch. */
    const val VERSION = "0.1.3"

    fun dir(ctx: Context): File = File(ctx.filesDir, "mod")

    fun stage(ctx: Context, log: (String) -> Unit) {
        val dest = dir(ctx)
        val mark = File(dest, MARK)
        if (mark.isFile && mark.readText().trim() == VERSION) return

        log("正在展开外挂文件…")
        dest.deleteRecursively()
        val n = Assets.copyTree(ctx, "mod", dest)
        // the launcher writes its per-session jsonl here, and an empty directory cannot ride in assets
        File(dest, "logs").mkdirs()
        mark.writeText(VERSION)
        log("外挂文件就绪（$n 个文件）。")
    }
}
