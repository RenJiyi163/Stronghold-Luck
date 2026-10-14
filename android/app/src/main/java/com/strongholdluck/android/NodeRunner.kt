package com.strongholdluck.android

import android.util.Log
import com.sun.jna.FunctionMapper
import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.StringArray
import java.lang.reflect.Method

/**
 * libnode.so, entered through JNA.
 *
 * There is no JNI shim here on purpose. libnode exports `node::Start(int, char**)` under its C++ mangled
 * name, and JNA calls a mangled symbol directly once it is told the name, so the whole native side of
 * this app is the two .so files the build drops into jniLibs.
 *
 * Those two: `libnode.so` (60 MB, fetched by scripts/fetch-libnode.sh, not committed) and
 * `libc++_shared.so`. The second one is the trap. libnode depends on the C++ runtime, the nodejs-mobile
 * release does not ship it, and an APK that carries only libnode.so dies at startup with
 * `dlopen failed: library "libc++_shared.so" not found` — which the player sees as a white page.
 */
interface NodeLibrary : Library {
    fun nodeStart(argc: Int, argv: StringArray): Int
}

private class Mangled : FunctionMapper {
    override fun getFunctionName(libraryName: String, method: Method): String =
        if (method.name == "nodeStart") "_ZN4node5StartEiPPc" else method.name
}

object NodeRunner {
    private const val TAG = "NodeRunner"

    private val lib: NodeLibrary by lazy {
        Native.load("node", NodeLibrary::class.java, mapOf(Library.OPTION_FUNCTION_MAPPER to Mangled()))
    }

    /**
     * Run node with [argv] (argv[0] is the program name, conventionally "node"). Blocks until the event
     * loop exits, so this must not be called on the UI thread.
     */
    fun start(argv: Array<String>): Int {
        Log.i(TAG, "node::Start ${argv.joinToString(" ")}")
        return lib.nodeStart(argv.size, StringArray(argv, "UTF-8"))
    }
}
