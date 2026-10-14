package com.strongholdluck.android

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.system.Os
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.BufferedReader
import java.io.File
import java.io.FileInputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * The whole app is one screen with two states.
 *
 * Before the game is up it shows a status line and a log — the first launch downloads the art and audio
 * (about 560 MB) and unpacks it, which takes minutes; afterwards the same screen comes up in a second or
 * two. When the server answers on 127.0.0.1 the WebView takes over and the setup screen goes away.
 *
 * Node runs in this process through libnode (see NodeRunner), on its own thread, and the launcher is
 * started the same way a desktop run starts it: `node src/launcher.mjs --game <dir> --no-open --host
 * 0.0.0.0`. The launcher then brings up the game server behind its own front door, which is what puts
 * the panel on the page.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "StrongholdLuck"
        private const val SERVER = "http://127.0.0.1:3000"
        private const val SLOW_START_MS = 180_000L
        private const val STATE_STARTED = "started"
    }

    private val ui = Handler(Looper.getMainLooper())

    private lateinit var web: WebView
    private lateinit var panel: LinearLayout
    private lateinit var status: TextView
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var retry: Button

    private var running = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        buildUi()
        if (savedInstanceState?.getBoolean(STATE_STARTED) != true) {
            running = true
            thread(name = "bootstrap") { bootstrap() }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_STARTED, running)
    }

    override fun onBackPressed() {
        // Backing out should not take the server down with it: the game keeps its match in memory and a
        // friend may still be connected. Send the app to the background instead.
        moveTaskToBack(true)
    }

    // ---- the screen ---------------------------------------------------------------------------------

    private fun dp(n: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, n.toFloat(), resources.displayMetrics
    ).toInt()

    private fun buildUi() {
        val root = FrameLayout(this)

        web = WebView(this).apply {
            visibility = View.GONE
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true   // the game keeps its settings and stats in localStorage
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        WebView.setWebContentsDebuggingEnabled(true)
        root.addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0C0F0E"))
            setPadding(dp(24), dp(18), dp(24), dp(18))
        }

        val title = TextView(this).apply {
            text = "卫戍协议 · 自选商店"
            setTextColor(Color.parseColor("#4ED8AF"))
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
        }
        status = TextView(this).apply {
            text = "正在准备…"
            setTextColor(Color.parseColor("#F2F2F2"))
            textSize = 15f
            setPadding(0, dp(8), 0, dp(8))
        }
        logView = TextView(this).apply {
            setTextColor(Color.parseColor("#8A948F"))
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
        }
        logScroll = ScrollView(this).apply { addView(logView) }
        retry = Button(this).apply {
            text = "重试"
            visibility = View.GONE
            setOnClickListener {
                if (running) return@setOnClickListener
                running = true
                retry.visibility = View.GONE
                thread(name = "bootstrap") { bootstrap() }
            }
        }

        panel.addView(title)
        panel.addView(status)
        panel.addView(logScroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        panel.addView(retry, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.END })
        root.addView(panel, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        setContentView(root)
    }

    /** Append a line to the on-screen log; callable from any thread. */
    private fun say(line: String) {
        Log.i(TAG, line)
        ui.post {
            if (logView.length() > 24_000) logView.text = logView.text.takeLast(16_000)
            logView.append(line.trimEnd() + "\n")
            status.text = line
            logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
        }
    }

    // ---- the work -----------------------------------------------------------------------------------

    private fun bootstrap() {
        try {
            ModPack.stage(this, ::say)
            GamePack.stageCode(this, ::say)

            if (!GamePack.isReady(this)) {
                say("首次启动：先取游戏素材，之后就不用再下了。")
                GamePack.download(this, ::say)
                say("正在解压素材，这一步最慢，别退出。")
                GamePack.extract(this, ::say)
                GamePack.zipFile(this).delete()
                say("游戏素材就绪。")
            }

            say("正在启动游戏…")
            launchNode()
        } catch (t: Throwable) {
            Log.e(TAG, "bootstrap failed", t)
            say("出错了：${t.message}")
            running = false
            ui.post { retry.visibility = View.VISIBLE }
        }
    }

    private fun launchNode() {
        captureNodeOutput()

        val mod = ModPack.dir(this)
        val game = GamePack.gameDir(this)
        val argv = arrayOf(
            "node",
            File(mod, "src/launcher.mjs").absolutePath,
            "--game", game.absolutePath,
            "--no-open",
            "--host", "0.0.0.0",
        )

        thread(name = "node") {
            try {
                NodeRunner.start(argv)
            } catch (t: Throwable) {
                Log.e(TAG, "node::Start failed", t)
                say("Node 没起来：${t.message}")
            }
            // the event loop ended: the game is over, so there is nothing left on this screen
            ui.post { finish() }
        }

        thread(name = "health") {
            if (waitForServer()) {
                say("游戏起来了。")
                ui.post {
                    web.loadUrl(SERVER)
                    web.visibility = View.VISIBLE
                    panel.visibility = View.GONE
                }
            } else {
                say("等了 ${SLOW_START_MS / 1000} 秒没等到服务器（127.0.0.1:3000）。上面几行里应该写着原因。")
                running = false
                ui.post { retry.visibility = View.VISIBLE }
            }
        }
    }

    private fun waitForServer(): Boolean {
        val deadline = System.currentTimeMillis() + SLOW_START_MS
        while (System.currentTimeMillis() < deadline) {
            try {
                val conn = (URL("$SERVER/healthz").openConnection() as HttpURLConnection).apply {
                    connectTimeout = 3_000
                    readTimeout = 3_000
                }
                try {
                    if (conn.responseCode == 200) return true
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                // not listening yet
            }
            Thread.sleep(1000)
        }
        return false
    }

    /**
     * An app process has fd 1 and 2 pointed at /dev/null, so everything Node prints — the launcher's
     * banners, the game's own startup, and above all any stack trace — is thrown away before it can be
     * read. Give them a pipe and read it back into the on-screen log.
     */
    private fun captureNodeOutput() {
        try {
            val pipe = ParcelFileDescriptor.createPipe()
            val readEnd = pipe[0]
            val writeFd = pipe[1].detachFd()
            Os.dup2(writeFd, 1)
            Os.dup2(writeFd, 2)
            Os.close(writeFd)
            thread(name = "node-output", isDaemon = true) {
                try {
                    BufferedReader(InputStreamReader(FileInputStream(readEnd.fileDescriptor), Charsets.UTF_8)).use { reader ->
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isNotBlank()) say("[node] $line")
                        }
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "reading node output stopped", t)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "could not capture node output", t)
        }
    }
}
