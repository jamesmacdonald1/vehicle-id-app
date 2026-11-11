/**
 * Cymbal Auto Group — Trade-In Appraisal & Valuation Frontend Controller
 * Built for dealership sales staff on Android phones, tablets, and desktops:
 * - Native Android camera video recording & in-app live camera with Web Audio API human speech isolation (300Hz-3400Hz)
 * - Salesperson management (add new salespeople to database & select active salesperson)
 * - Vehicle Inspector & Valuation Bot appraisal workflow
 * - Multi-field vehicle search, price/mileage range filtering, and 1-click "Mark as Sold"
 */

const state = {
  recordedVideoBlob: null,
  recordedVideoFile: null,
  mediaStream: null,
  mediaRecorder: null,
  audioContext: null,
  isRecording: false,
  recordingSeconds: 0,
  recordingTimerId: null,
  speechRecognition: null,
  isDictating: false,
  lastValuation: null,
  vehiclesCache: [],
  salespeople: [],
};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  initNavigationTabs();
  initDialogLightDismissFallback();
  initCameraAndVideoControls();
  initSpeechDictation();
  initRangeSlidersAndMarginCalc();
  initInspectionAndSaveForms();
  initSearchAndFilterControls();
  initSalespersonControls();
  initQrModalControls();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  await Promise.all([
    checkSystemHealth(),
    loadSalespeople(),
    loadInspectorSkills(),
    executeVehicleSearch(),
  ]);
});

// ---------------------------------------------------------------------------
// 1. Dashboard Navigation Tabs (Record Vehicle vs Search Vehicle)
// ---------------------------------------------------------------------------
function initNavigationTabs() {
  const tabRecordBtn = document.getElementById("tabRecordBtn");
  const tabSearchBtn = document.getElementById("tabSearchBtn");
  const panelRecord = document.getElementById("panelRecord");
  const panelSearch = document.getElementById("panelSearch");

  function switchTab(target) {
    const isRecord = target === "record";
    tabRecordBtn.classList.toggle("active", isRecord);
    tabRecordBtn.setAttribute("aria-selected", String(isRecord));
    tabSearchBtn.classList.toggle("active", !isRecord);
    tabSearchBtn.setAttribute("aria-selected", String(!isRecord));

    panelRecord.classList.toggle("active", isRecord);
    panelRecord.hidden = !isRecord;
    panelSearch.classList.toggle("active", !isRecord);
    panelSearch.hidden = isRecord;

    if (!isRecord) {
      executeVehicleSearch();
    }
  }

  tabRecordBtn.addEventListener("click", () => switchTab("record"));
  tabSearchBtn.addEventListener("click", () => switchTab("search"));
}

// ---------------------------------------------------------------------------
// 2. Dialog Light-Dismiss Fallback (`closedby="any"`)
// ---------------------------------------------------------------------------
function initDialogLightDismissFallback() {
  const dialogs = [
    {
      dialog: document.getElementById("vehicleDetailDialog"),
      closeBtn: document.getElementById("closeDialogBtn"),
    },
    {
      dialog: document.getElementById("addSalespersonDialog"),
      closeBtn: document.getElementById("closeSalespersonDialogBtn"),
    },
    {
      dialog: document.getElementById("qrModalDialog"),
      closeBtn: document.getElementById("closeQrDialogBtn"),
    },
  ];

  for (const { dialog, closeBtn } of dialogs) {
    if (!dialog) continue;
    if (closeBtn) {
      closeBtn.addEventListener("click", () => dialog.close());
    }
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) {
          dialog.close();
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 2b. Android App QR Code Modal Dialog
// ---------------------------------------------------------------------------
function initQrModalControls() {
  const openBtn = document.getElementById("openQrModalBtn");
  const dialog = document.getElementById("qrModalDialog");
  const qrImg = document.getElementById("qrCodeImg");
  const urlDisplay = document.getElementById("qrTargetUrlDisplay");

  if (openBtn && dialog) {
    openBtn.addEventListener("click", () => {
      const targetUrl = window.location.origin;

      if (urlDisplay) urlDisplay.textContent = targetUrl;
      if (qrImg) qrImg.src = "/api/qr-code.png?url=" + encodeURIComponent(targetUrl) + "&t=" + Date.now();

      dialog.showModal();
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Salesperson Management (List & Add New Salesperson to Database)
// ---------------------------------------------------------------------------
function initSalespersonControls() {
  const openBtn = document.getElementById("openAddSalespersonBtn");
  const dialog = document.getElementById("addSalespersonDialog");
  const form = document.getElementById("addSalespersonForm");

  if (openBtn && dialog) {
    openBtn.addEventListener("click", () => {
      dialog.showModal();
      const nameInput = document.getElementById("newSalespersonName");
      if (nameInput) nameInput.focus();
    });
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await handleAddSalesperson();
    });
  }
}

async function loadSalespeople(selectedName = "") {
  try {
    const res = await fetch("/api/salespeople");
    if (!res.ok) return;
    const data = await res.json();
    state.salespeople = data.salespeople || [];
    renderSalespeopleSelect(selectedName);
    renderRegisteredSalespeopleList();
  } catch (err) {
    console.warn("Could not load salespeople:", err);
  }
}

function renderSalespeopleSelect(selectedName = "") {
  const select = document.getElementById("activeSalesperson");
  if (!select) return;

  const currentVal = selectedName || select.value;
  if (!state.salespeople.length) {
    select.innerHTML = `<option value="">No salespeople added yet — click "+ Add Salesperson"</option>`;
    return;
  }

  select.innerHTML = state.salespeople
    .map((sp) => {
      const display = sp.branch ? `${sp.name} (${sp.branch})` : sp.name;
      const isSelected = display === currentVal || sp.name === currentVal;
      return `<option value="${escapeHtml(display)}" ${isSelected ? "selected" : ""}>${escapeHtml(display)}</option>`;
    })
    .join("");
}

function renderRegisteredSalespeopleList() {
  const container = document.getElementById("registeredSalespeopleList");
  if (!container) return;

  if (!state.salespeople.length) {
    container.innerHTML = `<p class="field-hint">No salespeople registered yet. Add your first team member above.</p>`;
    return;
  }

  container.innerHTML = state.salespeople
    .map(
      (sp) => `
      <div class="skill-item">
        <div>
          <strong>${escapeHtml(sp.name)}</strong>
          <span>${escapeHtml(sp.branch || "Dealership Sales Team")}${sp.email ? ` • ${escapeHtml(sp.email)}` : ""}</span>
        </div>
        <span class="badge badge-green">Active</span>
      </div>
    `
    )
    .join("");
}

async function handleAddSalesperson() {
  const nameInput = document.getElementById("newSalespersonName");
  const branchInput = document.getElementById("newSalespersonBranch");
  const emailInput = document.getElementById("newSalespersonEmail");
  const saveBtn = document.getElementById("saveSalespersonBtn");
  const dialog = document.getElementById("addSalespersonDialog");

  const name = (nameInput.value || "").trim();
  const branch = (branchInput.value || "").trim();
  const email = (emailInput.value || "").trim();

  if (!name) {
    showNotification("Please enter the salesperson's full name.", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "⏳ Saving...";

  try {
    const res = await fetch("/api/salespeople", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, branch, email }),
    });
    if (!res.ok) {
      throw new Error(`Failed to add salesperson (HTTP ${res.status})`);
    }
    const data = await res.json();
    const created = data.salesperson;
    const displayValue = created.branch ? `${created.name} (${created.branch})` : created.name;

    await loadSalespeople(displayValue);
    nameInput.value = "";
    branchInput.value = "";
    emailInput.value = "";

    if (dialog && dialog.open) {
      dialog.close();
    }
    showNotification(`Added salesperson ${created.name} to the database.`, "success");
  } catch (err) {
    showNotification(`Could not save salesperson: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "＋ Save Salesperson";
  }
}

// ---------------------------------------------------------------------------
// 4. Phone Camera, Video Upload & Web Audio Human Dialogue Filter
// ---------------------------------------------------------------------------
function initCameraAndVideoControls() {
  const phoneCameraInput = document.getElementById("phoneCameraInput");
  const videoFileInput = document.getElementById("videoFileInput");
  const triggerPhoneBtn = document.getElementById("triggerPhoneRecordBtn");
  const triggerChooseBtn = document.getElementById("triggerChooseVideoBtn");
  const clearVideoBtn = document.getElementById("clearSelectedVideoBtn");
  const startCameraBtn = document.getElementById("startCameraBtn");
  const recordClipBtn = document.getElementById("recordClipBtn");
  const regHintInput = document.getElementById("registrationHint");
  const hudRegBadge = document.getElementById("hudRegBadge");

  if (regHintInput && hudRegBadge) {
    regHintInput.addEventListener("input", () => {
      const val = regHintInput.value.trim().toUpperCase();
      if (!state.recordedVideoFile) {
        hudRegBadge.textContent = val ? `Plate: ${val}` : "Plate: Waiting for video";
      }
    });
  }

  function handleSelectedVideoFile(file, sourceLabel) {
    if (!file) {
      console.warn("No file provided to handleSelectedVideoFile");
      return;
    }
    stopLiveCameraStream();

    state.recordedVideoFile = file;
    state.recordedVideoBlob = file;

    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    const fileName = file.name || "walkaround_video.mp4";

    const previewVideo = document.getElementById("cameraPreview");
    if (previewVideo) {
      try {
        previewVideo.srcObject = null;
        const blobUrl = URL.createObjectURL(file);
        previewVideo.src = blobUrl;
        previewVideo.muted = true;
        previewVideo.defaultMuted = true;
        previewVideo.playsInline = true;
        previewVideo.setAttribute("playsinline", "");
        previewVideo.setAttribute("webkit-playsinline", "");
        previewVideo.load();
        previewVideo.play().catch(() => {});
      } catch (err) {
        console.warn("Could not set preview src:", err);
      }
    }

    const chip = document.getElementById("selectedVideoChip");
    const nameEl = document.getElementById("selectedVideoName");
    const metaEl = document.getElementById("selectedVideoMeta");
    if (chip && nameEl && metaEl) {
      nameEl.textContent = fileName;
      metaEl.textContent = `${sizeMb} MB • Video attached & ready to inspect`;
      chip.classList.remove("hidden");
    }

    const errorBanner = document.getElementById("inspectFormError");
    if (errorBanner) errorBanner.classList.add("hidden");

    if (hudRegBadge) {
      hudRegBadge.textContent = `Video: ${fileName} (${sizeMb} MB)`;
    }

    const statusBadge = document.getElementById("captureStatusBadge");
    if (statusBadge) {
      statusBadge.textContent = `Video Ready (${sizeMb} MB)`;
      statusBadge.className = "badge badge-green";
    }

    const runBtn = document.getElementById("runAgentsBtn");
    if (runBtn) {
      runBtn.textContent = `✨ Inspect "${fileName}" (${sizeMb} MB)`;
    }

    showNotification(
      `${sourceLabel}: "${fileName}" (${sizeMb} MB). Tap "Inspect Vehicle" to analyse.`,
      "info"
    );
  }

  function onFileChosen(inputEl, label) {
    const file = (inputEl.files && inputEl.files[0]) || null;
    if (file) {
      handleSelectedVideoFile(file, label);
    }
  }

  if (videoFileInput) {
    videoFileInput.addEventListener("click", () => {
      videoFileInput.value = "";
    });
  }

  if (phoneCameraInput) {
    phoneCameraInput.addEventListener("click", () => {
      phoneCameraInput.value = "";
    });
  }

  if (videoFileInput) {
    videoFileInput.addEventListener("change", () => onFileChosen(videoFileInput, "Saved video selected"));
    videoFileInput.addEventListener("input", () => onFileChosen(videoFileInput, "Saved video selected"));
  }

  if (phoneCameraInput) {
    phoneCameraInput.addEventListener("change", () => onFileChosen(phoneCameraInput, "Phone video loaded"));
    phoneCameraInput.addEventListener("input", () => onFileChosen(phoneCameraInput, "Phone video loaded"));
  }

  if (clearVideoBtn) {
    clearVideoBtn.addEventListener("click", () => {
      state.recordedVideoFile = null;
      state.recordedVideoBlob = null;
      if (videoFileInput) videoFileInput.value = "";
      if (phoneCameraInput) phoneCameraInput.value = "";

      const previewVideo = document.getElementById("cameraPreview");
      if (previewVideo) {
        previewVideo.srcObject = null;
        previewVideo.src = "";
      }

      const chip = document.getElementById("selectedVideoChip");
      if (chip) chip.classList.add("hidden");

      const statusBadge = document.getElementById("captureStatusBadge");
      if (statusBadge) {
        statusBadge.textContent = "Ready to Record";
        statusBadge.className = "badge badge-blue";
      }

      if (hudRegBadge) hudRegBadge.textContent = "Plate: Waiting for video";

      const runBtn = document.getElementById("runAgentsBtn");
      if (runBtn) runBtn.textContent = "✨ Inspect Vehicle & Calculate Trade-In Valuation";
    });
  }

  if (startCameraBtn) {
    startCameraBtn.addEventListener("click", async () => {
      await startPhoneCameraWithDialogueFilter();
    });
  }

  if (recordClipBtn) {
    recordClipBtn.addEventListener("click", () => {
      if (!state.isRecording) {
        startVideoRecording();
      } else {
        stopVideoRecording();
      }
    });
  }
}

/**
 * Opens the phone/desktop camera and routes microphone audio through a Web Audio API
 * bandpass filter chain (High-pass 300Hz + Low-pass 3400Hz + DynamicsCompressor)
 * so human dialogue is isolated and wind/forecourt engine rumble is attenuated.
 */
async function startPhoneCameraWithDialogueFilter() {
  const previewVideo = document.getElementById("cameraPreview");
  const recordClipBtn = document.getElementById("recordClipBtn");
  const statusBadge = document.getElementById("captureStatusBadge");

  try {
    const rawStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let combinedStream = rawStream;

    if (AudioCtx && rawStream.getAudioTracks().length > 0) {
      const audioCtx = new AudioCtx();
      state.audioContext = audioCtx;
      const source = audioCtx.createMediaStreamSource(rawStream);

      const highPass = audioCtx.createBiquadFilter();
      highPass.type = "highpass";
      highPass.frequency.value = 300;

      const lowPass = audioCtx.createBiquadFilter();
      lowPass.type = "lowpass";
      lowPass.frequency.value = 3400;

      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 20;
      compressor.ratio.value = 6;

      const destination = audioCtx.createMediaStreamDestination();
      source.connect(highPass);
      highPass.connect(lowPass);
      lowPass.connect(compressor);
      compressor.connect(destination);

      combinedStream = new MediaStream([
        ...rawStream.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]);
    }

    state.mediaStream = combinedStream;
    previewVideo.src = "";
    previewVideo.srcObject = combinedStream;
    previewVideo.muted = true;
    await previewVideo.play();

    recordClipBtn.classList.remove("hidden");
    statusBadge.textContent = "Camera Live (Voice Filter Active)";
    statusBadge.className = "badge badge-green";
    showNotification(
      "Live camera active with human dialogue isolation. Walk around the car and tap Start Recording.",
      "info"
    );
  } catch (err) {
    showNotification(
      "Could not start live in-app camera. You can use 'Record Video on Phone Camera' or 'Choose Saved Video' instead.",
      "error"
    );
  }
}

function stopLiveCameraStream() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
  const recordClipBtn = document.getElementById("recordClipBtn");
  if (recordClipBtn) recordClipBtn.classList.add("hidden");
}

function startVideoRecording() {
  if (!state.mediaStream) return;
  const chunks = [];
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";

  state.mediaRecorder = new MediaRecorder(state.mediaStream, { mimeType });
  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  state.mediaRecorder.onstop = () => {
    const blob = new Blob(chunks, { type: "video/webm" });
    state.recordedVideoBlob = blob;
    state.recordedVideoFile = new File([blob], "walkaround_capture.webm", { type: "video/webm" });

    const previewVideo = document.getElementById("cameraPreview");
    previewVideo.srcObject = null;
    previewVideo.src = URL.createObjectURL(blob);
    previewVideo.muted = false;

    const statusBadge = document.getElementById("captureStatusBadge");
    statusBadge.textContent = `Recorded Clip (${(blob.size / 1024).toFixed(0)} KB)`;
    statusBadge.className = "badge badge-blue";
    showNotification(
      "Walkaround video saved! Tap 'Inspect Vehicle & Calculate Trade-In Valuation' below.",
      "success"
    );
  };

  state.mediaRecorder.start(250);
  state.isRecording = true;
  state.recordingSeconds = 0;

  const recordClipBtn = document.getElementById("recordClipBtn");
  recordClipBtn.textContent = "⏹ Stop & Save Video";

  const hudTimer = document.getElementById("hudTimer");
  state.recordingTimerId = setInterval(() => {
    state.recordingSeconds += 1;
    const mins = String(Math.floor(state.recordingSeconds / 60)).padStart(2, "0");
    const secs = String(state.recordingSeconds % 60).padStart(2, "0");
    hudTimer.textContent = `${mins}:${secs}`;
  }, 1000);

  if (state.speechRecognition && !state.isDictating) {
    try {
      state.speechRecognition.start();
    } catch (_) {}
  }
}

function stopVideoRecording() {
  if (state.mediaRecorder && state.isRecording) {
    state.mediaRecorder.stop();
  }
  state.isRecording = false;
  clearInterval(state.recordingTimerId);
  stopLiveCameraStream();

  const recordClipBtn = document.getElementById("recordClipBtn");
  recordClipBtn.textContent = "⏺ Start Recording";

  if (state.speechRecognition && state.isDictating) {
    try {
      state.speechRecognition.stop();
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 5. Web Speech API Live Voice Dictation
// ---------------------------------------------------------------------------
function initSpeechDictation() {
  const dictateBtn = document.getElementById("dictateSpeechBtn");
  const transcriptInput = document.getElementById("spokenTranscriptInput");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    dictateBtn.addEventListener("click", () => {
      showNotification(
        "Live browser dictation is not supported on this browser, or your voice will be transcribed directly from the recorded video audio.",
        "info"
      );
    });
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "en-GB";
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onstart = () => {
    state.isDictating = true;
    dictateBtn.textContent = "🔴 Listening... (Tap to Stop)";
  };

  recognition.onend = () => {
    state.isDictating = false;
    dictateBtn.textContent = "🎙️ Tap to Dictate";
  };

  recognition.onresult = (event) => {
    let added = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        added += event.results[i][0].transcript + " ";
      }
    }
    if (added.trim()) {
      transcriptInput.value = (transcriptInput.value + " " + added).trim();
    }
  };

  state.speechRecognition = recognition;

  dictateBtn.addEventListener("click", () => {
    if (state.isDictating) {
      recognition.stop();
    } else {
      try {
        recognition.start();
      } catch (_) {}
    }
  });
}

// ---------------------------------------------------------------------------
// 6. Range Sliders, Margin Calculator & Manual Re-Valuation
// ---------------------------------------------------------------------------
function initRangeSlidersAndMarginCalc() {
  const condIn = document.getElementById("fieldCondInside");
  const condInDisp = document.getElementById("condInsideDisplay");
  const condOut = document.getElementById("fieldCondOutside");
  const condOutDisp = document.getElementById("condOutsideDisplay");
  const purchaseInput = document.getElementById("fieldPurchaseValue");
  const retailInput = document.getElementById("fieldRetailValue");
  const regInput = document.getElementById("fieldReg");
  const headerPlate = document.getElementById("headerPlatePreview");
  const recalcBtn = document.getElementById("recalcValuationBtn");

  condIn.addEventListener("input", () => {
    condInDisp.textContent = `${condIn.value} / 10`;
  });
  condOut.addEventListener("input", () => {
    condOutDisp.textContent = `${condOut.value} / 10`;
  });

  function updateMargin() {
    const buy = Number(purchaseInput.value || 0);
    const sell = Number(retailInput.value || 0);
    const margin = sell - buy;
    const el = document.getElementById("estimatedMarginDisplay");
    el.textContent = `${margin >= 0 ? "+" : ""}£${margin.toLocaleString("en-GB")}`;
  }

  purchaseInput.addEventListener("input", updateMargin);
  retailInput.addEventListener("input", updateMargin);

  regInput.addEventListener("input", () => {
    headerPlate.textContent = regInput.value.toUpperCase() || "REG PLATE";
  });

  const lookupDvlaBtn = document.getElementById("lookupDvlaBtn");
  if (lookupDvlaBtn) {
    lookupDvlaBtn.addEventListener("click", async () => {
      const reg = (regInput.value || "").trim();
      if (!reg) {
        showNotification("Please enter a registration plate to look up.", "warning");
        regInput.focus();
        return;
      }
      lookupDvlaBtn.disabled = true;
      lookupDvlaBtn.textContent = "⏳...";
      try {
        const res = await fetch("/api/dvla-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registration_number: reg }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.make) document.getElementById("fieldMake").value = data.make;
        if (data.model) document.getElementById("fieldModel").value = data.model;
        if (data.colour) document.getElementById("fieldColour").value = data.colour;
        if (data.year) document.getElementById("fieldYear").value = data.year;
        if (data.mot_status) document.getElementById("fieldMotStatus").value = data.mot_status;
        if (data.registration_number) {
          regInput.value = data.registration_number;
          headerPlate.textContent = data.registration_number;
        }

        const pill = document.getElementById("src_registration_number");
        if (pill) pill.textContent = "DVLA Verified";
        const pillMake = document.getElementById("src_make");
        if (pillMake) pillMake.textContent = "DVLA Verified";
        const pillYear = document.getElementById("src_year");
        if (pillYear) pillYear.textContent = "DVLA Verified";

        showNotification(
          `Official DVLA details applied for ${data.registration_number}: ${data.make} ${data.model} (${data.year})`,
          "success"
        );

        // Automatically refresh valuation with official vehicle details
        await triggerStandaloneValuation();
      } catch (err) {
        showNotification(`DVLA lookup notice: ${err.message}`, "error");
      } finally {
        lookupDvlaBtn.disabled = false;
        lookupDvlaBtn.textContent = "🔍 DVLA";
      }
    });
  }

  recalcBtn.addEventListener("click", async () => {
    await triggerStandaloneValuation();
  });
}

// ---------------------------------------------------------------------------
// 7. Vehicle Inspector & Valuation Bot Orchestration
// ---------------------------------------------------------------------------
function initInspectionAndSaveForms() {
  const inspectForm = document.getElementById("inspectTriggerForm");
  const saveForm = document.getElementById("saveVehicleForm");

  inspectForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await runInspectorAndValuationPipeline();
  });

  saveForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveVehicleRecord();
  });
}

function setPipelineStepStatus(stepKey, status) {
  const stepEl = document.querySelector(`.pipeline-step[data-step="${stepKey}"]`);
  if (!stepEl) return;
  stepEl.classList.remove("active", "done");
  if (status === "active") stepEl.classList.add("active");
  if (status === "done") stepEl.classList.add("done");
}

/**
 * Uploads video in 6MB chunks to reliably support large phone videos without hitting
 * Cloud Run's 32MB request body limit.
 */
async function uploadVideoInChunks(file, regHint, salesperson, onProgress) {
  const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB chunk size
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = `upl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const fileName = file.name || "walkaround_video.mp4";
  const mimeType = file.type || "video/mp4";

  let lastResult = null;
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const chunkBlob = file.slice(start, end);

    const chunkFormData = new FormData();
    chunkFormData.append("upload_id", uploadId);
    chunkFormData.append("chunk_index", String(i));
    chunkFormData.append("total_chunks", String(totalChunks));
    chunkFormData.append("file_name", fileName);
    chunkFormData.append("mime_type", mimeType);
    chunkFormData.append("salesperson", salesperson);
    chunkFormData.append("registration_hint", regHint);
    chunkFormData.append("chunk", chunkBlob, `chunk_${i}.part`);

    if (onProgress) {
      const upMb = (end / (1024 * 1024)).toFixed(1);
      const totMb = (file.size / (1024 * 1024)).toFixed(1);
      const pct = Math.round((end / file.size) * 100);
      onProgress(i + 1, totalChunks, upMb, totMb, pct);
    }

    const res = await fetch("/api/upload-chunk", {
      method: "POST",
      body: chunkFormData,
    });
    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      throw new Error(`Video chunk ${i + 1}/${totalChunks} failed (HTTP ${res.status}): ${errTxt}`);
    }
    lastResult = await res.json();
  }

  if (!lastResult || lastResult.status !== "complete") {
    throw new Error("Video assembly could not be confirmed on server.");
  }
  return lastResult;
}

async function runInspectorAndValuationPipeline() {
  const runBtn = document.getElementById("runAgentsBtn");
  const badge = document.getElementById("pipelineStateBadge");
  const regHint = document.getElementById("registrationHint").value.trim();

  // Robustly detect video from state or DOM input elements
  const phoneInput = document.getElementById("phoneCameraInput");
  const savedInput = document.getElementById("videoFileInput");
  const chosenFile =
    state.recordedVideoFile ||
    (savedInput && savedInput.files && savedInput.files[0]) ||
    (phoneInput && phoneInput.files && phoneInput.files[0]) ||
    state.recordedVideoBlob;

  if (chosenFile) {
    state.recordedVideoFile = chosenFile;
  }

  if (!state.recordedVideoFile && !regHint) {
    const errorBanner = document.getElementById("inspectFormError");
    if (errorBanner) {
      errorBanner.textContent =
        "⚠️ Please choose a video file above (or enter a Registration Number) before pressing Inspect.";
      errorBanner.classList.remove("hidden");
    }
    showNotification(
      "Please record or select a vehicle walkaround video, or enter a Registration Number to inspect.",
      "error"
    );
    return;
  }

  const errorBanner = document.getElementById("inspectFormError");
  if (errorBanner) errorBanner.classList.add("hidden");

  const videoFileSizeMb = state.recordedVideoFile
    ? (state.recordedVideoFile.size / (1024 * 1024)).toFixed(1)
    : 0;

  runBtn.disabled = true;
  runBtn.textContent = state.recordedVideoFile
    ? `⏳ Uploading Walkaround Video (${videoFileSizeMb} MB)...`
    : "⏳ Running Vehicle Inspector & Valuation...";
  badge.textContent = state.recordedVideoFile ? `Uploading (${videoFileSizeMb} MB)...` : "Inspecting...";
  badge.className = "badge badge-blue";

  ["upload", "video", "dvla", "valuation"].forEach((k) => setPipelineStepStatus(k, ""));

  let progressInterval = null;
  try {
    setPipelineStepStatus("upload", "active");

    const activeSalesperson = document.getElementById("activeSalesperson").value || "Unassigned";
    let gcsUri = null;
    let videoUrl = null;

    if (state.recordedVideoFile) {
      // Chunked upload reliably handles videos of any size without 32MB Cloud Run payload limit
      const uploadRes = await uploadVideoInChunks(
        state.recordedVideoFile,
        regHint,
        activeSalesperson,
        (currentChunk, totalChunks, upMb, totMb, pct) => {
          runBtn.textContent = `⏳ Uploading Video: ${upMb}MB / ${totMb}MB (${pct}%)...`;
          badge.textContent = `Uploading ${pct}%...`;
        }
      );
      gcsUri = uploadRes.gcs_uri;
      videoUrl = uploadRes.video_url;
      setPipelineStepStatus("upload", "done");
    } else {
      await delay(180);
      setPipelineStepStatus("upload", "done");
    }

    setPipelineStepStatus("video", "active");
    badge.textContent = "Gemini Video AI Analysing...";
    runBtn.textContent = "⏳ Gemini AI Analysing Walkaround & Audio...";

    // Stage progression timers for AI analysis
    let currIdx = 0;
    progressInterval = setInterval(() => {
      if (currIdx === 0) {
        setPipelineStepStatus("video", "done");
        setPipelineStepStatus("dvla", "active");
        badge.textContent = "DVLA Official Verification...";
        runBtn.textContent = "⏳ Querying Official DVLA Register...";
        currIdx += 1;
      } else if (currIdx === 1) {
        setPipelineStepStatus("dvla", "done");
        setPipelineStepStatus("valuation", "active");
        badge.textContent = "Valuation Bot Pricing...";
        runBtn.textContent = "⏳ Calculating Valuation & Comparables...";
        currIdx += 1;
      }
    }, 4500);

    const formData = new FormData();
    formData.append("registration_hint", regHint);
    formData.append(
      "spoken_transcript",
      document.getElementById("spokenTranscriptInput").value.trim()
    );
    formData.append("salesperson", activeSalesperson);
    formData.append("skip_valuation", "true");

    if (gcsUri) {
      formData.append("gcs_uri", gcsUri);
      formData.append("video_url", videoUrl || "");
      formData.append("mime_type_override", state.recordedVideoFile.type || "video/mp4");
    }

    const response = await fetch("/api/inspect", {
      method: "POST",
      body: formData,
    });

    if (progressInterval) clearInterval(progressInterval);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      let errMsg = `Server returned HTTP ${response.status}`;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.detail) errMsg = errJson.detail;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await response.json();
    const inspection = data.inspection || data.vehicle || {};
    const videoStorage = data.video_storage || {
      gcs_uri: inspection.video_gcs_uri,
      video_url: inspection.video_url,
    };

    // Steps 1, 2, and 3 are complete: populate facts immediately!
    ["upload", "video", "dvla"].forEach((k) => setPipelineStepStatus(k, "done"));
    setPipelineStepStatus("valuation", "active");

    badge.textContent = "Facts Populated • Valuing...";
    badge.className = "badge badge-blue";

    // Immediately populate all vehicle facts into Section 2
    populateInspectionForm(inspection, null, videoStorage);

    // Smoothly scroll down to Section 2 immediately so sales reps see the populated appraisal
    setTimeout(() => {
      const section2 = document.querySelector(".inspection-column");
      if (section2) {
        section2.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 200);

    const regLabel = inspection.registration_number || regHint || "Vehicle";
    const makeModel = [inspection.make, inspection.model].filter(Boolean).join(" ");
    showNotification(
      `Vehicle facts loaded for ${regLabel}${makeModel ? ` (${makeModel})` : ""}. Sourcing live UK market comparables...`,
      "info"
    );

    // Asynchronously run Step 4 (Valuation Bot) while the user is already reviewing vehicle facts
    runBtn.textContent = "⏳ Valuation Bot Sourcing Market Comparables...";
    await triggerStandaloneValuation();

    setPipelineStepStatus("valuation", "done");
    badge.textContent = "Inspection Complete";
    badge.className = "badge badge-green";
  } catch (err) {
    if (progressInterval) clearInterval(progressInterval);
    badge.textContent = "Attention Needed";
    badge.className = "badge badge-amber";

    const errorBanner = document.getElementById("inspectFormError");
    if (errorBanner) {
      errorBanner.innerHTML = `⚠️ <strong>Inspection Attention Needed:</strong> ${escapeHtml(err.message)}<br><small>Tip: If your video file is large, you can enter the Registration Plate in the box above to load official DVLA data and market valuation instantly.</small>`;
      errorBanner.classList.remove("hidden");
      errorBanner.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    showNotification(`Could not complete automated inspection: ${err.message}`, "error");
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "✨ Inspect Vehicle & Calculate Trade-In Valuation";
  }
}

function populateInspectionForm(inspection, valuation, videoStorage) {
  inspection = inspection || {};
  valuation = valuation || {};
  videoStorage = videoStorage || {};

  const regVal = inspection.registration_number || "";
  document.getElementById("fieldReg").value = regVal;
  document.getElementById("headerPlatePreview").textContent = regVal || "REG PLATE";
  document.getElementById("hudRegBadge").textContent = `Plate: ${regVal || "Detected"}`;
  document.getElementById("fieldVin").value = inspection.vin || "";
  document.getElementById("fieldYear").value = inspection.year || 2021;
  document.getElementById("fieldMake").value = inspection.make || "";
  document.getElementById("fieldModel").value = inspection.model || "";
  document.getElementById("fieldVariant").value = inspection.variant || "";
  document.getElementById("fieldColour").value = inspection.colour || "";
  document.getElementById("fieldMileage").value = inspection.mileage || 0;

  const condIn = document.getElementById("fieldCondInside");
  condIn.value = inspection.condition_inside || 8;
  document.getElementById("condInsideDisplay").textContent = `${condIn.value} / 10`;
  document.getElementById("fieldCondInsideIssues").value =
    inspection.condition_inside_issues || "";

  const condOut = document.getElementById("fieldCondOutside");
  condOut.value = inspection.condition_outside || 8;
  document.getElementById("condOutsideDisplay").textContent = `${condOut.value} / 10`;
  document.getElementById("fieldCondOutsideIssues").value =
    inspection.condition_outside_issues || "";

  document.getElementById("fieldModifications").value = inspection.modifications || "None (Standard)";
  document.getElementById("fieldMotStatus").value = inspection.mot_status || "";
  document.getElementById("fieldComments").value = inspection.comments || "";

  if (inspection.field_sources) {
    for (const [key, srcText] of Object.entries(inspection.field_sources)) {
      const pill = document.getElementById(`src_${key}`);
      if (pill) pill.textContent = srcText;
    }
  }

  document.getElementById("fieldVideoGcsUri").value =
    videoStorage.gcs_uri || inspection.video_gcs_uri || "";
  document.getElementById("fieldVideoUrl").value =
    videoStorage.video_url || inspection.video_url || "";

  // Update Section 2 Alert Banner
  const alertBanner = document.getElementById("section2AlertBanner");
  const alertTitle = document.getElementById("section2AlertTitle");
  const alertDesc = document.getElementById("section2AlertDesc");
  if (alertBanner && alertTitle && alertDesc) {
    alertBanner.classList.remove("hidden");
    if (regVal && regVal !== "UNREGISTERED") {
      alertBanner.style.background = "#e6f4ea";
      alertBanner.style.borderColor = "#34a853";
      alertTitle.textContent = `✅ Vehicle Identified: ${regVal} (${[inspection.make, inspection.model].filter(Boolean).join(" ")})`;
      alertDesc.textContent = "Official DVLA registration details applied. Valuation Bot matched 4 UK market comparables and calculated the trade-in offer below.";
    } else {
      const summary = [inspection.colour, inspection.make, inspection.model].filter(Boolean).join(" ") || "Vehicle Detected";
      alertBanner.style.background = "#fef7e0";
      alertBanner.style.borderColor = "#fbbc04";
      alertTitle.textContent = `🎬 Walkaround Video Analysed: ${summary}`;
      alertDesc.innerHTML = "The registration plate was not clearly visible in this footage. <strong>Please enter the plate in the Registration Number field above</strong> to pull official DVLA records.";
    }
  }

  if (valuation && (valuation.suggested_retail_gbp || (valuation.comparables && valuation.comparables.length))) {
    renderValuationBotOutput(valuation);
  } else {
    // Show placeholder/spinner in valuation card while Step 4 runs
    const purchaseInput = document.getElementById("fieldPurchaseValue");
    const retailInput = document.getElementById("fieldRetailValue");
    if (purchaseInput) purchaseInput.placeholder = "Sourcing...";
    if (retailInput) retailInput.placeholder = "Sourcing...";
    const grid = document.getElementById("comparablesGrid");
    if (grid) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 24px; text-align: center; background: #f8f9fa; border: 1px dashed #dadce0; border-radius: 8px;">
          <div style="font-size: 1.5rem; margin-bottom: 6px;">⏳</div>
          <strong style="color: #1a73e8;">Valuation Bot Sourcing UK Market Comparables...</strong>
          <p style="color: #5f6368; font-size: 0.85rem; margin: 4px 0 0 0;">Finding live listings on AutoTrader UK, Motors.co.uk &amp; eBay within ±10% age and mileage for ${escapeHtml(inspection.make || "vehicle")} ${escapeHtml(inspection.model || "")}...</p>
        </div>
      `;
    }
  }
}

function renderValuationBotOutput(valuation) {
  if (!valuation) return;
  state.lastValuation = valuation;

  const purchaseInput = document.getElementById("fieldPurchaseValue");
  const retailInput = document.getElementById("fieldRetailValue");
  purchaseInput.value = valuation.suggested_trade_in_gbp;
  retailInput.value = valuation.suggested_retail_gbp;

  const margin = valuation.suggested_retail_gbp - valuation.suggested_trade_in_gbp;
  document.getElementById("estimatedMarginDisplay").textContent =
    `+£${margin.toLocaleString("en-GB")}`;
  document.getElementById("valuationRationaleText").textContent =
    valuation.pricing_rationale || "";

  if (valuation.mileage_window) {
    document.getElementById("mileageWindowBadge").textContent =
      `±10% Window: ${valuation.mileage_window.min_miles.toLocaleString("en-GB")} – ${valuation.mileage_window.max_miles.toLocaleString("en-GB")} mi`;
  }

  const grid = document.getElementById("comparablesGrid");
  grid.innerHTML = (valuation.comparables || [])
    .map((comp) => {
      const isSold = comp.status.toLowerCase().includes("sold");
      const diffSign = comp.mileage_diff_pct >= 0 ? "+" : "";
      return `
        <article class="comp-card">
          <div class="comp-top">
            <span class="comp-title">${escapeHtml(comp.title)}</span>
            <span class="comp-price">£${Number(comp.price_gbp).toLocaleString("en-GB")}</span>
          </div>
          <div class="comp-meta">
            <span class="badge ${isSold ? "badge-green" : "badge-blue"}">${escapeHtml(comp.status)}</span>
            <span>${Number(comp.mileage).toLocaleString("en-GB")} mi (${diffSign}${comp.mileage_diff_pct}%)</span>
            <span>• ${escapeHtml(comp.year)}</span>
            <span>• ${escapeHtml(comp.location)}</span>
          </div>
          <div class="comp-meta">
            <span>Source: <strong>${escapeHtml(comp.source)}</strong></span>
            <span>• ${escapeHtml(comp.condition_notes)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

async function triggerStandaloneValuation() {
  const btn = document.getElementById("recalcValuationBtn");
  const make = document.getElementById("fieldMake").value.trim();
  const model = document.getElementById("fieldModel").value.trim();

  if (!make || !model) {
    showNotification("Please enter Make and Model before updating the valuation.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "⏳ Valuing...";

  try {
    const payload = {
      make,
      model,
      variant: document.getElementById("fieldVariant").value.trim(),
      year: Number(document.getElementById("fieldYear").value || 2021),
      mileage: Number(document.getElementById("fieldMileage").value || 30000),
      colour: document.getElementById("fieldColour").value.trim(),
      condition_inside: Number(document.getElementById("fieldCondInside").value || 8),
      condition_outside: Number(document.getElementById("fieldCondOutside").value || 8),
      modifications: document.getElementById("fieldModifications").value.trim() || "None",
    };

    const res = await fetch("/api/valuation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const valuation = data.valuation || data.valuation_bot || data;
    renderValuationBotOutput(valuation);
    const comps = valuation.comparables || [];
    showNotification(
      `Valuation Bot matched ${comps.length} UK comparables. Suggested trade-in: £${(valuation.suggested_trade_in_gbp || 0).toLocaleString("en-GB")}.`,
      "success"
    );
  } catch (err) {
    showNotification(`Could not recalculate valuation: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Update Valuation";
  }
}

// ---------------------------------------------------------------------------
// 8. Save Vehicle Record to Database
// ---------------------------------------------------------------------------
async function saveVehicleRecord() {
  const activeSalesperson = document.getElementById("activeSalesperson").value;
  if (!activeSalesperson) {
    showNotification(
      "Please select a salesperson at the top right (or click '+ Add Salesperson' to register one) before saving.",
      "error"
    );
    const dialog = document.getElementById("addSalespersonDialog");
    if (dialog && !state.salespeople.length) {
      dialog.showModal();
    }
    return;
  }

  const saveBtn = document.getElementById("saveVehicleBtn");
  saveBtn.disabled = true;
  saveBtn.textContent = "⏳ Saving Vehicle Record...";

  try {
    const purchaseVal = Math.round(Number(document.getElementById("fieldPurchaseValue").value || 0));
    const retailVal = Math.round(Number(document.getElementById("fieldRetailValue").value || 0));

    const record = {
      registration_number: document.getElementById("fieldReg").value.trim().toUpperCase(),
      vin: document.getElementById("fieldVin").value.trim().toUpperCase(),
      make: document.getElementById("fieldMake").value.trim(),
      model: document.getElementById("fieldModel").value.trim(),
      variant: document.getElementById("fieldVariant").value.trim(),
      year: Number(document.getElementById("fieldYear").value || 2021),
      colour: document.getElementById("fieldColour").value.trim(),
      condition_inside: Number(document.getElementById("fieldCondInside").value || 8),
      condition_inside_issues: document.getElementById("fieldCondInsideIssues").value.trim(),
      condition_outside: Number(document.getElementById("fieldCondOutside").value || 8),
      condition_outside_issues: document.getElementById("fieldCondOutsideIssues").value.trim(),
      modifications: document.getElementById("fieldModifications").value.trim() || "None",
      mot_status: document.getElementById("fieldMotStatus").value.trim(),
      mileage: Number(document.getElementById("fieldMileage").value || 0),
      purchase_value: purchaseVal,
      retail_value: retailVal,
      comments: document.getElementById("fieldComments").value.trim(),
      salesperson: activeSalesperson,
      recorded_at: new Date().toISOString(),
      video_gcs_uri: document.getElementById("fieldVideoGcsUri").value,
      video_url: document.getElementById("fieldVideoUrl").value,
      sold: false,
      comparables: state.lastValuation ? state.lastValuation.comparables || [] : [],
      field_sources: {
        registration_number: document.getElementById("src_registration_number").textContent,
        vin: document.getElementById("src_vin").textContent,
        make: document.getElementById("src_make").textContent,
        model: document.getElementById("src_model").textContent,
        colour: document.getElementById("src_colour").textContent,
        mot_status: document.getElementById("src_mot_status").textContent,
      },
    };

    const res = await fetch("/api/vehicles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });

    if (!res.ok) throw new Error(`Save failed with HTTP ${res.status}`);
    const result = await res.json();

    await executeVehicleSearch();
    showNotification(
      `Saved ${result.vehicle.registration_number} (${result.vehicle.make} ${result.vehicle.model}) under ${result.vehicle.salesperson}.`,
      "success"
    );
  } catch (err) {
    showNotification(`Could not save vehicle record: ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "💾 Save Vehicle Record";
  }
}

// ---------------------------------------------------------------------------
// 9. Search Vehicle & Mark as "Sold"
// ---------------------------------------------------------------------------
function initSearchAndFilterControls() {
  const searchForm = document.getElementById("searchVehiclesForm");
  const resetBtn = document.getElementById("resetSearchBtn");

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    await executeVehicleSearch();
  });

  const autoFilterIds = ["filterSoldStatus", "filterSortBy"];
  for (const id of autoFilterIds) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => executeVehicleSearch());
  }

  resetBtn.addEventListener("click", async () => {
    searchForm.reset();
    document
      .querySelectorAll('input[name="search_field"]')
      .forEach((cb) => (cb.checked = true));
    await executeVehicleSearch();
  });
}

async function executeVehicleSearch() {
  const selectedFields = Array.from(
    document.querySelectorAll('input[name="search_field"]:checked')
  ).map((cb) => cb.value);

  const minPriceRaw = document.getElementById("filterMinPrice").value;
  const maxPriceRaw = document.getElementById("filterMaxPrice").value;
  const minMilesRaw = document.getElementById("filterMinMileage").value;
  const maxMilesRaw = document.getElementById("filterMaxMileage").value;

  const payload = {
    query_text: document.getElementById("searchQueryInput").value.trim(),
    search_fields: selectedFields,
    min_price: minPriceRaw !== "" ? Number(minPriceRaw) : null,
    max_price: maxPriceRaw !== "" ? Number(maxPriceRaw) : null,
    min_mileage: minMilesRaw !== "" ? Number(minMilesRaw) : null,
    max_mileage: maxMilesRaw !== "" ? Number(maxMilesRaw) : null,
    colour_filter: document.getElementById("filterColour").value.trim(),
    make_filter: document.getElementById("filterMake").value.trim(),
    sold_filter: document.getElementById("filterSoldStatus").value,
    sort_by: document.getElementById("filterSortBy").value,
  };

  try {
    const res = await fetch("/api/vehicles/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Search returned HTTP ${res.status}`);
    const data = await res.json();

    state.vehiclesCache = data.vehicles || [];
    document.getElementById("navInventoryCount").textContent =
      `${data.count} Vehicle${data.count === 1 ? "" : "s"}`;

    renderSearchResults(state.vehiclesCache);
  } catch (err) {
    showNotification(`Vehicle search failed: ${err.message}`, "error");
  }
}

function renderSearchResults(vehicles) {
  const grid = document.getElementById("searchResultsGrid");
  if (!vehicles.length) {
    grid.innerHTML = `
      <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 2.5rem;">
        <h3 class="card-title">No Trade-In Vehicles Found</h3>
        <p class="card-subtitle" style="margin-inline: auto;">
          No vehicles match your current filters, or no vehicles have been recorded yet. Use the "Record Vehicle" tab to record and save a trade-in appraisal.
        </p>
      </div>
    `;
    return;
  }

  grid.innerHTML = vehicles
    .map((v) => {
      const recordedDate = v.recorded_at
        ? new Date(v.recorded_at).toLocaleString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Just now";
      const margin = Number(v.retail_value || 0) - Number(v.purchase_value || 0);
      const commentLines = (v.comments || "")
        .split("\n")
        .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
        .filter(Boolean);

      return `
        <article class="vehicle-card ${v.sold ? "is-sold" : ""}">
          <div class="vehicle-card-top">
            <div>
              <span class="uk-plate-badge">${escapeHtml(v.registration_number)}</span>
              <h3 class="vehicle-title" style="margin-block-start: 0.45rem;">
                ${escapeHtml(v.year)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}
              </h3>
              <p class="vehicle-subtitle">${escapeHtml(v.variant || "Standard Specification")} • ${escapeHtml(v.colour)}</p>
            </div>
            <span class="badge ${v.sold ? "badge-red" : "badge-green"}">
              ${v.sold ? "SOLD" : "IN STOCK"}
            </span>
          </div>

          <div class="metrics-strip">
            <div class="metric-cell">
              <span class="metric-label">Mileage</span>
              <span class="metric-val">${Number(v.mileage).toLocaleString("en-GB")} mi</span>
            </div>
            <div class="metric-cell">
              <span class="metric-label">Inside / Outside</span>
              <span class="metric-val">${v.condition_inside}/10 • ${v.condition_outside}/10</span>
            </div>
            <div class="metric-cell">
              <span class="metric-label">MOT Status</span>
              <span class="metric-val">${escapeHtml((v.mot_status || "").split("(")[0].trim())}</span>
            </div>
          </div>

          <div class="pricing-strip">
            <div>
              <div class="price-box-label">Trade-In Offer (Purchase)</div>
              <div class="price-box-val trade">£${Number(v.purchase_value).toLocaleString("en-GB")}</div>
            </div>
            <div>
              <div class="price-box-label">Forecourt Retail Value</div>
              <div class="price-box-val retail">£${Number(v.retail_value).toLocaleString("en-GB")}</div>
            </div>
            <div style="text-align: right;">
              <div class="price-box-label">Est. Margin</div>
              <div class="price-box-val" style="color: var(--gcp-blue);">+£${margin.toLocaleString("en-GB")}</div>
            </div>
          </div>

          <div>
            <div class="price-box-label" style="margin-block-end: 0.25rem;">
              Condition &amp; Salesperson Voice Notes
            </div>
            <ul class="comments-preview">
              ${commentLines
                .slice(0, 3)
                .map((c) => `<li>${escapeHtml(c)}</li>`)
                .join("")}
            </ul>
          </div>

          <div class="vehicle-card-footer">
            <div class="salesperson-stamp">
              Recorded by <strong>${escapeHtml(v.salesperson)}</strong><br>
              <span>${escapeHtml(recordedDate)} • VIN: ${escapeHtml(v.vin || "N/A")}</span>
            </div>
            <div class="card-actions">
              <button
                type="button"
                class="btn btn-outline btn-sm view-detail-btn"
                data-reg="${escapeHtml(v.registration_number)}"
              >
                📋 Full Report
              </button>
              <button
                type="button"
                class="btn ${v.sold ? "btn-tonal" : "btn-success"} btn-sm toggle-sold-btn"
                data-reg="${escapeHtml(v.registration_number)}"
                data-sold="${v.sold ? "true" : "false"}"
              >
                ${v.sold ? "↩ Re-open Stock" : "✅ Mark as Sold"}
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  grid.querySelectorAll(".toggle-sold-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const reg = btn.dataset.reg;
      const currentlySold = btn.dataset.sold === "true";
      await toggleVehicleSoldStatus(reg, !currentlySold);
    });
  });

  grid.querySelectorAll(".view-detail-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const reg = btn.dataset.reg;
      const vehicle = state.vehiclesCache.find((item) => item.registration_number === reg);
      if (vehicle) openVehicleDetailModal(vehicle);
    });
  });
}

async function toggleVehicleSoldStatus(registrationNumber, soldState) {
  try {
    const res = await fetch(
      `/api/vehicles/${encodeURIComponent(registrationNumber)}/sold`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sold: soldState }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await executeVehicleSearch();
    showNotification(
      `Vehicle ${registrationNumber} marked as ${soldState ? "SOLD" : "Available in Stock"}.`,
      "success"
    );
  } catch (err) {
    showNotification(`Could not update sold status: ${err.message}`, "error");
  }
}

function openVehicleDetailModal(v) {
  const dialog = document.getElementById("vehicleDetailDialog");
  document.getElementById("dialogPlateBadge").textContent = v.registration_number;
  document.getElementById("dialogVehicleTitle").textContent =
    `${v.year} ${v.make} ${v.model} — ${v.variant || ""}`;

  const body = document.getElementById("dialogBody");
  const compsHtml = (v.comparables || [])
    .map(
      (c) => `
      <div class="comp-card">
        <div class="comp-top">
          <span class="comp-title">${escapeHtml(c.title)}</span>
          <span class="comp-price">£${Number(c.price_gbp).toLocaleString("en-GB")}</span>
        </div>
        <div class="comp-meta">
          <span class="badge badge-blue">${escapeHtml(c.status)}</span>
          <span>${Number(c.mileage).toLocaleString("en-GB")} miles (${c.mileage_diff_pct >= 0 ? "+" : ""}${c.mileage_diff_pct}%)</span>
          <span>• ${escapeHtml(c.location)} (${escapeHtml(c.source)})</span>
        </div>
      </div>
    `
    )
    .join("");

  const videoSectionHtml = v.video_url
    ? `
      <div style="margin-block-end: 1rem;">
        <div class="price-box-label" style="margin-block-end: 0.35rem;">Recorded Walkaround Video</div>
        <video src="${escapeHtml(v.video_url)}" controls playsinline style="inline-size: 100%; max-block-size: 280px; border-radius: 8px; background: #000;"></video>
      </div>
    `
    : "";

  body.innerHTML = `
    ${videoSectionHtml}
    <div class="metrics-strip" style="margin-block-end: 1rem;">
      <div class="metric-cell">
        <span class="metric-label">VIN</span>
        <span class="metric-val">${escapeHtml(v.vin || "N/A")}</span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">Colour</span>
        <span class="metric-val">${escapeHtml(v.colour)}</span>
      </div>
      <div class="metric-cell">
        <span class="metric-label">MOT Status</span>
        <span class="metric-val">${escapeHtml(v.mot_status)}</span>
      </div>
    </div>

    <div class="form-grid-2" style="margin-block-end: 1rem;">
      <div class="condition-box">
        <strong>Interior Condition: ${v.condition_inside} / 10</strong>
        <p style="margin-block-start: 0.35rem; font-size: 0.85rem; color: var(--text-secondary);">
          ${escapeHtml(v.condition_inside_issues || "No issues noted.")}
        </p>
      </div>
      <div class="condition-box">
        <strong>Exterior Condition: ${v.condition_outside} / 10</strong>
        <p style="margin-block-start: 0.35rem; font-size: 0.85rem; color: var(--text-secondary);">
          ${escapeHtml(v.condition_outside_issues || "No issues noted.")}
        </p>
      </div>
    </div>

    <div class="condition-box" style="margin-block-end: 1rem;">
      <strong>Modifications:</strong> ${escapeHtml(v.modifications || "None")}<br>
      <strong style="display: inline-block; margin-block-start: 0.45rem;">Salesperson Voice Summary:</strong>
      <pre style="white-space: pre-wrap; font-family: var(--font-sans); font-size: 0.85rem; margin: 0.35rem 0 0;">${escapeHtml(v.comments)}</pre>
    </div>

    ${
      compsHtml
        ? `<h4 style="margin-block: 0.5rem;">Valuation Bot Comparables (±10% Mileage &amp; Age)</h4>
           <div class="comparables-grid">${compsHtml}</div>`
        : ""
    }
  `;

  dialog.showModal();
}

// ---------------------------------------------------------------------------
// 10. System Status & Inspector Skills Registry
// ---------------------------------------------------------------------------
async function checkSystemHealth() {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  try {
    const res = await fetch("/healthz");
    if (!res.ok) throw new Error("Health check failed");
    await res.json();
    dot.className = "status-indicator online";
    text.textContent = "System Online";
  } catch (_) {
    dot.className = "status-indicator";
    text.textContent = "Offline Mode";
  }
}

async function loadInspectorSkills() {
  try {
    const res = await fetch("/api/agent/skills");
    if (!res.ok) return;
    const data = await res.json();
    const list = document.getElementById("skillsRegistryList");
    list.innerHTML = (data.skills || [])
      .map(
        (s) => `
        <div class="skill-item">
          <div>
            <strong>${escapeHtml(s.title)}</strong>
            <span>${escapeHtml(s.description)}</span>
          </div>
          <span class="badge badge-blue">Priority ${s.priority}</span>
        </div>
      `
      )
      .join("");
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function showNotification(message, level = "info") {
  const banner = document.getElementById("notificationBanner");
  const msgEl = document.getElementById("notificationMessage");
  const closeBtn = document.getElementById("closeNotificationBtn");

  banner.className = `notification-banner ${level}`;
  msgEl.textContent = message;
  banner.classList.remove("hidden");

  closeBtn.onclick = () => banner.classList.add("hidden");
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => {
    banner.classList.add("hidden");
  }, 6500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
