package com.strongholdluck.android

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Copying an APK asset tree out to a real directory.
 *
 * Everything the app runs has to be a real file: Node opens scripts and data by path, the launcher
 * writes `logs/` beside itself, and the game writes `.cache/` into its own tree. An APK asset is
 * read-only and has no path at all, so both the game and the mod are unpacked into the app's private
 * storage before anything starts.
 */
internal object Assets {
    private const val TAG = "Assets"

    /**
     * Copy `assets/[from]` into [to], overwriting. Returns how many files were written; [onProgress] is
     * called every few hundred of them (the first run unpacks ~10k files and the screen should say so).
     */
    fun copyTree(ctx: Context, from: String, to: File, onProgress: ((Int) -> Unit)? = null): Int {
        var count = 0
        fun walk(path: String, dest: File) {
            val kids = try { ctx.assets.list(path) } catch (e: IOException) { null } ?: emptyArray()
            if (kids.isEmpty()) {
                // list() answers the same for a file and for an empty directory; open() tells them apart
                try {
                    dest.parentFile?.mkdirs()
                    ctx.assets.open(path).use { input ->
                        FileOutputStream(dest).use { output -> input.copyTo(output, 1 shl 16) }
                    }
                    count++
                    if (count % 400 == 0) onProgress?.invoke(count)
                } catch (e: IOException) {
                    dest.mkdirs()
                }
                return
            }
            dest.mkdirs()
            for (kid in kids) walk("$path/$kid", File(dest, kid))
        }
        walk(from, to)
        Log.i(TAG, "unpacked $count files from assets/$from")
        return count
    }
}
