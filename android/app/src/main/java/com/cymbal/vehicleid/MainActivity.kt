package com.cymbal.vehicleid

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    companion object {
        // Set this to your deployed web app hostname (e.g. from Cloud Run deploy output)
        const val APP_HOST = "your-cloud-run-service.run.app"
        const val APP_URL = "https://$APP_HOST/"
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefreshLayout: SwipeRefreshLayout
    private lateinit var loadingProgressBar: ProgressBar

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var fileChooserLauncher: ActivityResultLauncher<Intent>? = null
    private var permissionLauncher: ActivityResultLauncher<Array<String>>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        swipeRefreshLayout = findViewById(R.id.swipeRefreshLayout)
        loadingProgressBar = findViewById(R.id.loadingProgressBar)

        setupLaunchers()
        checkAndRequestPermissions()
        setupWebView()
        setupSwipeRefresh()
        setupBackNavigation()

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL)
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun setupLaunchers() {
        // ActivityResult launcher for WebChromeClient.onShowFileChooser
        fileChooserLauncher = registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            val callback = fileUploadCallback ?: return@registerForActivityResult
            fileUploadCallback = null

            if (result.resultCode == Activity.RESULT_OK) {
                val data: Intent? = result.data
                val uriList = mutableListOf<Uri>()

                val clipData = data?.clipData
                if (clipData != null) {
                    for (i in 0 until clipData.itemCount) {
                        uriList.add(clipData.getItemAt(i).uri)
                    }
                } else {
                    data?.data?.let { uriList.add(it) }
                }

                callback.onReceiveValue(
                    if (uriList.isNotEmpty()) uriList.toTypedArray() else null
                )
            } else {
                callback.onReceiveValue(null)
            }
        }

        // Runtime permissions launcher for camera and microphone
        permissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { permissions ->
            val cameraGranted = permissions[Manifest.permission.CAMERA] ?: false
            val audioGranted = permissions[Manifest.permission.RECORD_AUDIO] ?: false
            if (!cameraGranted || !audioGranted) {
                Toast.makeText(
                    this,
                    R.string.camera_permission_required,
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun checkAndRequestPermissions() {
        val neededPermissions = mutableListOf<String>()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            neededPermissions.add(Manifest.permission.CAMERA)
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            neededPermissions.add(Manifest.permission.RECORD_AUDIO)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VIDEO)
                != PackageManager.PERMISSION_GRANTED
            ) {
                neededPermissions.add(Manifest.permission.READ_MEDIA_VIDEO)
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
            ) {
                neededPermissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }

        if (neededPermissions.isNotEmpty()) {
            permissionLauncher?.launch(neededPermissions.toTypedArray())
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.userAgentString = "${settings.userAgentString} CymbalVehicleIDApp/1.0"

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false
                val host = url.host ?: return false

                return if (host.contains(APP_HOST) || host.contains("localhost")) {
                    false
                } else {
                    // Open external links in external browser
                    try {
                        val intent = Intent(Intent.ACTION_VIEW, url)
                        startActivity(intent)
                    } catch (_: Exception) { }
                    true
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    Toast.makeText(
                        this@MainActivity,
                        "Network issue reaching dealership portal. Swipe down to retry.",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                swipeRefreshLayout.isRefreshing = false
                loadingProgressBar.visibility = View.GONE
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    loadingProgressBar.visibility = View.VISIBLE
                    loadingProgressBar.progress = newProgress
                } else {
                    loadingProgressBar.visibility = View.GONE
                }
            }

            // Handle Camera/Microphone requests from WebRTC / MediaRecorder
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                val requestedResources = request.resources
                val grantedList = mutableListOf<String>()

                for (res in requestedResources) {
                    if (res == PermissionRequest.RESOURCE_VIDEO_CAPTURE ||
                        res == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    ) {
                        grantedList.add(res)
                    }
                }

                if (grantedList.isNotEmpty()) {
                    runOnUiThread {
                        request.grant(grantedList.toTypedArray())
                    }
                } else {
                    runOnUiThread {
                        request.deny()
                    }
                }
            }

            // Handle file and video input chooser (<input type="file" accept="video/*" capture="environment">)
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback

                val chooserIntent = Intent(Intent.ACTION_CHOOSER)
                val targetIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "video/*"
                    addCategory(Intent.CATEGORY_OPENABLE)
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                }

                // Add camera capture intent as option
                val captureIntent = Intent(MediaStore.ACTION_VIDEO_CAPTURE)
                chooserIntent.putExtra(Intent.EXTRA_INTENT, targetIntent)
                chooserIntent.putExtra(Intent.EXTRA_TITLE, "Select or Record Walkaround Video")
                chooserIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(captureIntent))

                try {
                    fileChooserLauncher?.launch(chooserIntent)
                } catch (e: Exception) {
                    fileUploadCallback = null
                    return false
                }
                return true
            }
        }
    }

    private fun setupSwipeRefresh() {
        swipeRefreshLayout.setColorSchemeColors(
            ContextCompat.getColor(this, R.color.primary_blue),
            ContextCompat.getColor(this, R.color.secondary_green)
        )
        swipeRefreshLayout.setOnRefreshListener {
            webView.reload()
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }
}
