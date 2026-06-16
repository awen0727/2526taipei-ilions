(function () {
  "use strict";

  const { config, post, setMessage } = window.ILionsV2;
  const faceMembers = window.ILIONS_FACE_MEMBERS || [];
  const MODEL_URL = "https://vladmandic.github.io/face-api/model/";
  const FACE_API_URL = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
  const MATCH_THRESHOLD = 0.5;
  const SCAN_INTERVAL_MS = 800;

  const video = document.getElementById("faceVideo");
  if (!video) return;
  const videoBox = document.getElementById("faceVideoBox");
  const message = document.getElementById("faceMessage") || document.getElementById("message");
  const statusBadge = document.getElementById("faceStatusBadge");
  const matchName = document.getElementById("faceMatchName");
  const matchMeta = document.getElementById("faceMatchMeta");
  const startButton = document.getElementById("faceStartButton");
  const checkinButton = document.getElementById("faceCheckinButton");

  let matcher = null;
  let canvas = null;
  let scanTimer = null;
  let currentMatch = null;
  let isPosting = false;

  function setStatus(text) {
    statusBadge.textContent = text;
  }

  function imageSourcesFor(member) {
    const urls = (member.imageUrls || member.images || [])
      .map(url => ({ type: "url", value: String(url || "").trim() }));
    const driveIds = (member.driveFileIds || member.driveIds || [])
      .map(fileId => ({ type: "drive", value: String(fileId || "").trim() }));
    return urls.concat(driveIds).filter(source => source.value);
  }

  async function driveImageDataUrl(fileId) {
    const url = new URL(config.apiUrl);
    url.searchParams.set("action", "faceImage");
    url.searchParams.set("token", config.dashboardToken);
    url.searchParams.set("fileId", fileId);
    const response = await fetch(url);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "Drive 圖片讀取失敗");
    return result.dataUrl;
  }

  async function imageUrlForSource(source) {
    if (source.type === "drive") return driveImageDataUrl(source.value);
    return source.value;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.faceapi) {
        resolve();
        return;
      }
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error("face-api.js 載入失敗")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error("face-api.js 載入失敗，請確認網路連線"));
      document.head.appendChild(script);
    });
  }

  async function buildMatcher() {
    if (!faceMembers.length) {
      throw new Error("尚未設定 face-data.js，請先加入會員照片與 memberId");
    }

    setStatus("載入模型");
    await loadScript(FACE_API_URL);
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);

    const labeled = [];
    for (const member of faceMembers) {
      const descriptions = [];
      for (const source of imageSourcesFor(member)) {
        try {
          const url = await imageUrlForSource(source);
          const image = await faceapi.fetchImage(url);
          const detection = await faceapi.detectSingleFace(image).withFaceLandmarks().withFaceDescriptor();
          if (detection) descriptions.push(detection.descriptor);
        } catch (error) {
          // Keep loading other images; the final validation below reports members without usable photos.
        }
      }
      if (descriptions.length) {
        labeled.push(new faceapi.LabeledFaceDescriptors(member.label, descriptions));
      }
    }

    if (!labeled.length) throw new Error("沒有可用的人臉照片，請確認圖片路徑與照片清晰度");
    matcher = new faceapi.FaceMatcher(labeled, MATCH_THRESHOLD);
  }

  function memberForLabel(label) {
    return faceMembers.find(member => member.label === label) || null;
  }

  function setMatch(result) {
    if (!result || result.label === "unknown") {
      currentMatch = null;
      matchName.textContent = "尚未辨識到會員";
      matchMeta.textContent = "請看向鏡頭，辨識成功後會顯示姓名。";
      checkinButton.disabled = true;
      return;
    }

    const member = memberForLabel(result.label);
    currentMatch = {
      label: result.label,
      memberId: member ? member.memberId || "" : "",
      distance: result.distance
    };
    matchName.textContent = result.label;
    matchMeta.textContent = `辨識距離 ${result.distance.toFixed(3)}，確認無誤後可簽到。`;
    checkinButton.disabled = false;
  }

  async function scanFace() {
    if (!matcher || video.paused || video.ended) return;
    const detections = await faceapi.detectAllFaces(video).withFaceLandmarks().withFaceDescriptors();
    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    if (!displaySize.width || !displaySize.height) return;

    if (!canvas) {
      canvas = faceapi.createCanvasFromMedia(video);
      videoBox.appendChild(canvas);
    }
    faceapi.matchDimensions(canvas, displaySize);
    const resized = faceapi.resizeResults(detections, displaySize);
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);

    const results = resized.map(detection => matcher.findBestMatch(detection.descriptor));
    let best = null;
    results.forEach((result, index) => {
      if (!best || result.distance < best.distance) best = result;
      const box = resized[index].detection.box;
      const drawBox = new faceapi.draw.DrawBox(box, {
        label: result.toString(),
        boxColor: result.label === "unknown" ? "#b3261e" : "#fbd050"
      });
      drawBox.draw(canvas);
    });
    setMatch(best);
  }

  async function start() {
    try {
      startButton.disabled = true;
      setMessage(message, "正在載入模型與會員照片...", false);
      await buildMatcher();
      setStatus("請授權相機");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      video.srcObject = stream;
      await video.play();
      setStatus("辨識中");
      setMessage(message, "相機已啟動，請看向鏡頭。", false);
      scanTimer = window.setInterval(() => {
        scanFace().catch(error => setMessage(message, error.message, true));
      }, SCAN_INTERVAL_MS);
    } catch (error) {
      startButton.disabled = false;
      setStatus("未啟動");
      setMessage(message, error.message, true);
    }
  }

  async function checkIn() {
    if (!currentMatch || isPosting) return;
    try {
      isPosting = true;
      checkinButton.disabled = true;
      setMessage(message, "正在寫入簽到紀錄...", false);
      const result = await post({
        action: "faceCheckIn",
        token: config.dashboardToken,
        memberId: currentMatch.memberId,
        memberName: currentMatch.label,
        confidence: currentMatch.distance.toFixed(3),
        guestCount: Number(document.getElementById("faceGuestCount").value || 0),
        guestNames: document.getElementById("faceGuestNames").value.trim(),
        note: document.getElementById("faceNote").value.trim()
      });
      setMessage(message, result.message || "人臉簽到成功", false);
      setMatch(null);
      document.getElementById("faceGuestCount").value = "0";
      document.getElementById("faceGuestNames").value = "";
      document.getElementById("faceNote").value = "";
    } catch (error) {
      setMessage(message, error.message, true);
    } finally {
      isPosting = false;
      if (currentMatch) checkinButton.disabled = false;
    }
  }

  startButton.addEventListener("click", start);
  checkinButton.addEventListener("click", checkIn);
  window.addEventListener("pagehide", () => {
    if (scanTimer) window.clearInterval(scanTimer);
    const stream = video.srcObject;
    if (stream) stream.getTracks().forEach(track => track.stop());
  });
})();
