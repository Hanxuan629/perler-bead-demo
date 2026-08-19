"use strict";

/* Research trial v2: transcription, bilateral ending, and post-reveal consensus.
   This file intentionally contains no approved/system 12x12 answer rows. */
const TRIAL_SCHEMA_VERSION = "perler-trial/v1";
const PEER_PROTOCOL_VERSION = 2;
const ONLINE_BACKUP_KEY = "perler-bead-online-speaker-v4";
const TRANSCRIPTION_MODEL = "gpt-live-transcribe";

let draftLanguage = "auto";
let draftSpeechMeta = null;
let serverTrialHandle = null;
let serverTrialPromise = null;
let consensusSeenOps = new Set();
let speech = freshSpeechRuntime();

function freshSpeechRuntime(){
  return {
    status:"idle", pc:null, dc:null, stream:null, items:new Map(), order:[],
    baseDraft:"", rawTranscript:"", startedAt:null, finalizedAt:null,
    commitRequested:false, timer:null, message:""
  };
}

function isoTime(value){
  if(value === null || value === undefined) return null;
  return new Date(value).toISOString();
}
function gridToRows(grid){
  return grid.map(function(row){ return row.map(function(v){ return v ? "#" : "."; }).join(""); });
}
function rowsToGrid(rows){
  if(!Array.isArray(rows)) return null;
  return rows.map(function(row){ return Array.from(row, function(ch){ return ch === "#" ? 1 : 0; }); });
}
function validGrid(grid, rows, colsN){
  rows = rows || 12; colsN = colsN || 12;
  return Array.isArray(grid) && grid.length === rows && grid.every(function(row){
    return Array.isArray(row) && row.length === colsN && row.every(function(v){ return v === 0 || v === 1; });
  });
}
function validRows(rows){
  return Array.isArray(rows) && rows.length === 12 &&
    rows.every(function(row){ return typeof row === "string" && /^[.#]{12}$/.test(row); });
}
function roleNow(){ return myRole === "both" ? "both" : myRole; }
function isSpeakerAuthority(){ return MODE === "solo" || myRole === "speaker"; }
function currentSource(){
  if(state && state.revealedSource) return state.revealedSource;
  if(!state || !state.patternId || !PATTERNS[state.patternId]) return null;
  var p = PATTERNS[state.patternId];
  return {
    id:state.patternId,
    name:p.name,
    iconDataUri:p.iconDataUri || null,
    attribution:p.source || null
  };
}

function initialEnding(){
  return {
    requestedBy:null, requestedAt:null, confirmedBy:null, confirmedAt:null,
    communicationFinalRows:null, targetRevealedAt:null
  };
}
function initialConsensus(){
  return {
    rows:zerosDim(12,12), revision:0, actions:[],
    confirmations:{speaker:null, listener:null}, submittedAt:null
  };
}
function baseTrialState(patternId){
  var g = zerosDim(12,12);
  return {
    appVersion:APP_VERSION,
    protocolVersion:PEER_PROTOCOL_VERSION,
    trialId:crypto.randomUUID(),
    sessionId:crypto.randomUUID(),
    patternId:patternId || null,
    target:clone(g),
    committed:clone(g),
    design:clone(g),
    prediction:clone(g),
    predictionPending:[],
    predictionSubmittedAt:null,
    pendingSubmit:null,
    pending:[],
    rounds:[],
    instruction:"",
    currentInstructionMeta:null,
    roundStartRows:clone(g),
    phase:"speaker_turn",
    status:"communicating",
    awaitingRoundAck:false,
    roundNum:1,
    tSent:null,
    startedAt:Date.now(),
    ending:initialEnding(),
    consensus:initialConsensus(),
    revealedSource:null,
    completedAt:null,
    completedPayload:null,
    upload:{status:"idle", lastError:null, uploadedAt:null}
  };
}

function newSession(patternId){
  stopAndDiscardSpeech();
  draftInstr = "";
  draftSpeechMeta = null;
  draftLanguage = "auto";
  serverTrialHandle = null;
  serverTrialPromise = null;
  consensusSeenOps = new Set();
  state = baseTrialState(patternId || DEFAULT_PATTERN_ID);
  save();
  ensureServerTrial();
  if(MODE === "online" && myRole === "speaker") sendStart();
}

function blankOnlineState(){
  var next = baseTrialState(null);
  next.trialId = null;
  next.sessionId = null;
  return next;
}

function save(){
  if(!state) return;
  try{
    if(MODE === "solo"){
      localStorage.setItem(LSKEY, JSON.stringify(state));
      if(CHAN) CHAN.postMessage({type:"state"});
    } else if(myRole === "speaker"){
      localStorage.setItem(ONLINE_BACKUP_KEY, JSON.stringify(state));
    }
  }catch(e){}
  render();
}

function loadFromLS(){
  var raw = localStorage.getItem(LSKEY);
  if(!raw) return false;
  try{
    var restored = JSON.parse(raw);
    if(!restored || restored.appVersion !== APP_VERSION || !PATTERNS[restored.patternId]) return false;
    state = restored;
    state.target = zerosDim(12,12);
    state.ending = state.ending || initialEnding();
    state.consensus = state.consensus || initialConsensus();
    state.upload = state.upload || {status:"idle",lastError:null,uploadedAt:null};
    return true;
  }catch(e){ return false; }
}

async function ensureServerTrial(){
  if(!API_BASE || !state || !state.trialId || (MODE === "online" && myRole !== "speaker")) return null;
  if(serverTrialHandle && serverTrialHandle.trialId === state.trialId) return serverTrialHandle;
  if(serverTrialPromise) return serverTrialPromise;
  var expectedId = state.trialId;
  serverTrialPromise = (async function(){
    try{
      var response = await fetch(apiURL("/api/trials"), {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({trialId:expectedId})
      });
      var data = await response.json().catch(function(){ return {}; });
      if(!response.ok) throw new Error(data.error && data.error.message || "Could not create trial handle");
      if(!state || state.trialId !== expectedId) return null;
      serverTrialHandle = {trialId:data.trialId, writeToken:data.writeToken, expiresAt:data.expiresAt};
      return serverTrialHandle;
    }catch(error){
      if(state && state.trialId === expectedId){
        state.upload.status = "unavailable";
        state.upload.lastError = error.message;
        render();
      }
      return null;
    }finally{
      serverTrialPromise = null;
    }
  })();
  return serverTrialPromise;
}

function cleanupSpeechRuntime(){
  clearTimeout(speech.timer);
  if(speech.stream) speech.stream.getTracks().forEach(function(track){ try{ track.stop(); }catch(e){} });
  try{ if(speech.dc) speech.dc.close(); }catch(e){}
  try{ if(speech.pc) speech.pc.close(); }catch(e){}
  speech.stream = null; speech.dc = null; speech.pc = null; speech.timer = null;
}
function stopAndDiscardSpeech(){
  cleanupSpeechRuntime();
  speech = freshSpeechRuntime();
}
function assembledSpeechText(){
  return speech.order.map(function(id){
    var item = speech.items.get(id);
    return item ? item.text : "";
  }).filter(Boolean).join(" ").trim();
}
function refreshSpeechDraft(){
  speech.rawTranscript = assembledSpeechText();
  var joined = speech.baseDraft;
  if(joined && speech.rawTranscript) joined += " ";
  joined += speech.rawTranscript;
  draftInstr = joined;
  var box = document.getElementById("instrBox");
  if(box) box.value = draftInstr;
  updateSpeechStatusDOM();
}
function updateSpeechStatusDOM(){
  var label = document.getElementById("speechStatus");
  if(!label) return;
  var messages = {
    idle: API_BASE ? "Voice is ready; typing also works." : "Voice needs the experiment server; typing works now.",
    connecting:"Connecting secure transcription…",
    recording:"Listening — speak Chinese, English, or both.",
    finalizing:"Finishing transcript…",
    ready:"Transcript ready. Edit it before sending.",
    error:speech.message || "Voice transcription failed; type the instruction instead."
  };
  label.textContent = messages[speech.status] || "";
  label.className = "speech-status " + speech.status;
}

async function startTranscription(){
  if(!state || state.status !== "communicating" || state.phase !== "speaker_turn") return;
  if(MODE === "online" && myRole !== "speaker") return;
  if(!API_BASE){
    toast("Voice transcription needs the companion experiment server");
    return;
  }
  stopAndDiscardSpeech();
  draftSpeechMeta = null;
  speech.status = "connecting";
  speech.startedAt = Date.now();
  speech.baseDraft = draftInstr.trim();
  render();
  try{
    var tokenResponse = await fetch(apiURL("/api/realtime/client-secret") + "?language=" + encodeURIComponent(draftLanguage), {
      method:"POST"
    });
    var tokenData = await tokenResponse.json().catch(function(){ return {}; });
    if(!tokenResponse.ok) throw new Error(tokenData.error && tokenData.error.message || "Transcription is not configured");
    var ephemeral = tokenData.value ||
      (tokenData.client_secret && tokenData.client_secret.value) ||
      (tokenData.clientSecret && tokenData.clientSecret.value);
    if(!ephemeral) throw new Error("The server did not return a client secret");
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser cannot access a microphone");
    speech.stream = await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}
    });
    speech.pc = new RTCPeerConnection();
    speech.dc = speech.pc.createDataChannel("oai-events");
    speech.dc.onopen = function(){
      speech.status = "recording";
      speech.message = "";
      render();
    };
    speech.dc.onmessage = function(event){
      try{ handleTranscriptionEvent(JSON.parse(event.data)); }catch(e){}
    };
    speech.dc.onerror = function(){ speech.message = "The transcription channel reported an error."; };
    speech.pc.onconnectionstatechange = function(){
      if(["failed","disconnected"].includes(speech.pc && speech.pc.connectionState) &&
         speech.status !== "finalizing" && speech.status !== "ready"){
        failTranscription("The transcription connection closed.");
      }
    };
    speech.stream.getTracks().forEach(function(track){ speech.pc.addTrack(track, speech.stream); });
    var offer = await speech.pc.createOffer();
    await speech.pc.setLocalDescription(offer);
    var answerResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method:"POST",
      headers:{Authorization:"Bearer " + ephemeral, "Content-Type":"application/sdp"},
      body:offer.sdp
    });
    if(!answerResponse.ok) throw new Error("OpenAI Realtime connection failed");
    await speech.pc.setRemoteDescription({type:"answer", sdp:await answerResponse.text()});
  }catch(error){
    failTranscription(error.message || "Voice transcription failed");
  }
}

function handleTranscriptionEvent(event){
  if(!event || !event.type) return;
  if(event.type === "error"){
    failTranscription(event.error && event.error.message || "Transcription error");
    return;
  }
  if(event.type === "conversation.item.input_audio_transcription.delta"){
    var deltaId = event.item_id || "item";
    if(!speech.items.has(deltaId)){
      speech.items.set(deltaId, {text:""});
      speech.order.push(deltaId);
    }
    speech.items.get(deltaId).text += event.delta || "";
    refreshSpeechDraft();
    return;
  }
  if(event.type === "conversation.item.input_audio_transcription.completed"){
    var itemId = event.item_id || "item";
    if(!speech.items.has(itemId)){
      speech.items.set(itemId, {text:""});
      speech.order.push(itemId);
    }
    speech.items.get(itemId).text = event.transcript || speech.items.get(itemId).text;
    refreshSpeechDraft();
    if(speech.commitRequested) finalizeTranscription();
  }
}

function stopTranscription(){
  if(!["connecting","recording"].includes(speech.status)) return;
  if(speech.stream) speech.stream.getTracks().forEach(function(track){ try{ track.stop(); }catch(e){} });
  speech.commitRequested = true;
  speech.status = "finalizing";
  try{
    if(speech.dc && speech.dc.readyState === "open"){
      speech.dc.send(JSON.stringify({type:"input_audio_buffer.commit"}));
    }
  }catch(e){}
  render();
  speech.timer = setTimeout(finalizeTranscription, 5000);
}

function finalizeTranscription(){
  if(speech.status === "ready") return;
  speech.finalizedAt = Date.now();
  refreshSpeechDraft();
  draftSpeechMeta = {
    rawTranscript:speech.rawTranscript,
    recordingStartedAt:speech.startedAt,
    transcriptFinalizedAt:speech.finalizedAt,
    language:draftLanguage,
    model:TRANSCRIPTION_MODEL
  };
  cleanupSpeechRuntime();
  speech.status = "ready";
  speech.message = "";
  render();
}

function failTranscription(message){
  cleanupSpeechRuntime();
  speech.status = "error";
  speech.message = message;
  render();
  toast(message + " You can type instead.");
}

function freezeInstructionMeta(text){
  var raw = draftSpeechMeta && draftSpeechMeta.rawTranscript || null;
  return {
    language:draftSpeechMeta && draftSpeechMeta.language || draftLanguage,
    rawTranscript:raw,
    sentText:text,
    source:raw !== null ? "speech" : "typed",
    model:raw !== null ? TRANSCRIPTION_MODEL : null,
    edited:raw !== null ? raw.trim() !== text.trim() : false,
    recordingStartedAt:isoTime(draftSpeechMeta && draftSpeechMeta.recordingStartedAt),
    transcriptFinalizedAt:isoTime(draftSpeechMeta && draftSpeechMeta.transcriptFinalizedAt),
    sentAt:isoTime(Date.now())
  };
}

function doSend(text){
  var value = (text || "").trim();
  if(!value){ toast("Instruction cannot be empty"); return; }
  if(state.status !== "communicating" || state.phase !== "speaker_turn"){ toast("It is not the Speaker turn"); return; }
  if(MODE === "online" && (myRole !== "speaker" || !net.connected)){ toast("Speaker is not connected"); return; }
  if(["connecting","recording","finalizing"].includes(speech.status)){ toast("Stop and finish the transcript first"); return; }
  var now = Date.now();
  state.instruction = value;
  state.tSent = now;
  state.currentInstructionMeta = freezeInstructionMeta(value);
  state.currentInstructionMeta.sentAt = isoTime(now);
  state.pending = [];
  state.roundStartRows = clone(state.committed);
  state.prediction = clone(state.committed);
  state.predictionPending = [];
  state.predictionSubmittedAt = null;
  state.pendingSubmit = null;
  state.phase = "speaker_predict";
  if(MODE === "online"){
    if(!sendMsg({type:"instruction", text:value, round:state.roundNum})){
      state.phase = "speaker_turn";
      toast("Send failed — waiting to reconnect");
      return;
    }
    render();
  }else save();
  draftInstr = "";
  draftSpeechMeta = null;
  stopAndDiscardSpeech();
}

function doToggle(r, c){
  if(state.status !== "communicating" || state.phase !== "listener_turn") return;
  if(MODE === "online" && (myRole !== "listener" || !net.connected)) return;
  var was = state.design[r][c];
  state.design[r][c] = was ? 0 : 1;
  state.pending.push({type:was ? "DELETE" : "ADD", r:r, c:c, t:Date.now()});
  if(MODE === "online") render(); else save();
}

function doPredictToggle(r, c){
  if(state.status !== "communicating" || state.phase !== "speaker_predict") return;
  if(MODE === "online" && (myRole !== "speaker" || !net.connected)) return;
  var was = state.prediction[r][c];
  state.prediction[r][c] = was ? 0 : 1;
  state.predictionPending.push({type:was ? "DELETE" : "ADD", r:r, c:c, t:Date.now()});
  if(MODE === "online") render(); else save();
}

function confirmPrediction(){
  if(state.status !== "communicating" || state.phase !== "speaker_predict") return;
  if(MODE === "online" && myRole !== "speaker") return;
  state.predictionSubmittedAt = Date.now();
  state.phase = "listener_turn";
  if(MODE === "online"){
    render();
    if(state.pendingSubmit){
      var waiting = state.pendingSubmit;
      state.pendingSubmit = null;
      recordSubmission(waiting.design, waiting.actions, waiting.round);
    }
  }else save();
}

function doSubmit(){
  if(state.status !== "communicating" || state.phase !== "listener_turn"){ toast("It is not the Listener turn"); return; }
  if(MODE === "online"){
    if(myRole !== "listener" || !net.connected){ toast("Listener is not connected"); return; }
    if(!sendMsg({type:"submit", design:state.design, actions:state.pending.slice(), round:state.roundNum})){
      toast("Submit failed — waiting to reconnect"); return;
    }
    state.committed = clone(state.design);
    state.pending = [];
    state.awaitingRoundAck = true;
    state.phase = "awaiting_round_ack";
    render();
    toast("Submitted — waiting for round confirmation");
  }else{
    recordSubmission(state.design, state.pending.slice(), state.roundNum);
    state.pending = [];
    save();
  }
}

function recordSubmission(design, actions, round){
  if(!validGrid(design)) return;
  var submittedAt = Date.now();
  state.committed = clone(design);
  var pred = state.prediction ? clone(state.prediction) : null;
  var gap = pred ? hamming(pred, state.committed) : null;
  var meta = state.currentInstructionMeta || {
    language:"auto", rawTranscript:null, sentText:state.instruction, source:"typed",
    model:null, edited:false, recordingStartedAt:null, transcriptFinalizedAt:null,
    sentAt:isoTime(state.tSent)
  };
  var rd = {
    id:"r" + round,
    index:round,
    round:round,
    instruction:Object.assign({}, meta),
    speakerPrediction:{
      rows:pred ? gridToRows(pred) : null,
      submittedAt:isoTime(state.predictionSubmittedAt),
      actions:(state.predictionPending || []).slice()
    },
    listener:{
      startRows:gridToRows(state.roundStartRows || zerosDim(12,12)),
      submittedRows:gridToRows(state.committed),
      submittedAt:isoTime(submittedAt),
      actions:actions.slice()
    },
    metrics:{predictionListenerGap:gap},
    nActions:actions.length,
    beadsAfter:count(state.committed),
    predListenerGap:gap,
    designAfter:clone(state.committed),
    prediction:pred
  };
  state.rounds.push(rd);
  state.roundNum = round + 1;
  state.instruction = "";
  state.currentInstructionMeta = null;
  state.prediction = zerosDim(12,12);
  state.predictionPending = [];
  state.predictionSubmittedAt = null;
  state.phase = "speaker_turn";
  state.awaitingRoundAck = false;
  if(MODE === "online" && myRole === "speaker"){
    sendMsg({type:"round_ack", round:round, nextRound:state.roundNum, committed:state.committed});
    render();
  }else save();
}

function stableRoundBoundary(){
  return state && state.status === "communicating" && state.phase === "speaker_turn" &&
    !state.awaitingRoundAck && !state.pendingSubmit && state.roundNum > 1;
}

function requestTrialEnd(){
  if(!stableRoundBoundary()){
    toast("Finish at least one round and wait for its confirmation first");
    return;
  }
  var actor = roleNow() === "both" ? "speaker" : roleNow();
  var request = {requestedBy:actor, requestedAt:isoTime(Date.now())};
  state.status = "end_pending";
  state.ending = Object.assign(initialEnding(), request);
  if(MODE === "online"){
    if(!net.connected || !sendMsg({type:"end_request", request:request})){
      state.status = "communicating";
      state.ending = initialEnding();
      toast("Could not send the end request");
      return;
    }
    render();
  }else save();
}

function cancelEndRequest(){
  if(!state || state.status !== "end_pending") return;
  var actor = roleNow() === "both" ? "speaker" : roleNow();
  if(MODE === "online" && state.ending.requestedBy !== actor) return;
  if(MODE === "online") sendMsg({type:"end_cancel"});
  state.status = "communicating";
  state.ending = initialEnding();
  save();
}

function declineEndRequest(){
  if(!state || state.status !== "end_pending") return;
  if(MODE === "online") sendMsg({type:"end_response", accepted:false, by:roleNow(), at:isoTime(Date.now())});
  state.status = "communicating";
  state.ending = initialEnding();
  save();
}

function acceptEndRequest(){
  if(!state || state.status !== "end_pending") return;
  var actor = roleNow() === "both" ? "listener" : roleNow();
  var request = state.ending;
  if(MODE === "online" && actor === request.requestedBy){
    toast("The other participant must confirm the end");
    return;
  }
  request.confirmedBy = actor;
  request.confirmedAt = isoTime(Date.now());
  if(MODE === "solo"){
    beginConsensusAuthority();
    return;
  }
  if(myRole === "speaker"){
    beginConsensusAuthority();
  }else{
    sendMsg({type:"end_response", accepted:true, by:actor, at:request.confirmedAt});
    render();
  }
}

function beginConsensusAuthority(){
  if(!isSpeakerAuthority() || !state || state.status !== "end_pending") return;
  state.status = "consensus";
  state.phase = "consensus";
  state.ending.communicationFinalRows = gridToRows(state.committed);
  state.ending.targetRevealedAt = isoTime(Date.now());
  state.consensus = initialConsensus();
  state.revealedSource = currentSource();
  consensusSeenOps = new Set();
  if(MODE === "online"){
    sendMsg({
      type:"consensus_start",
      source:state.revealedSource,
      ending:state.ending,
      consensus:publicConsensusState()
    });
    render();
  }else save();
}

function publicConsensusState(){
  return {
    rows:gridToRows(state.consensus.rows),
    revision:state.consensus.revision,
    actions:state.consensus.actions.slice(),
    confirmations:Object.assign({}, state.consensus.confirmations),
    submittedAt:state.consensus.submittedAt
  };
}

function sendConsensusState(){
  if(MODE === "online" && myRole === "speaker"){
    sendMsg({type:"consensus_state", consensus:publicConsensusState(), status:state.status, completedAt:state.completedAt});
  }
}

function applyConsensusEdit(r, c, value, actor, opId, baseRevision){
  if(!isSpeakerAuthority() || state.status !== "consensus") return;
  if(!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= 12 || c < 0 || c >= 12) return;
  if(value !== 0 && value !== 1) return;
  if(opId && consensusSeenOps.has(opId)){ sendConsensusState(); return; }
  if(opId) consensusSeenOps.add(opId);
  var from = state.consensus.rows[r][c];
  if(from === value){ sendConsensusState(); return; }
  state.consensus.rows[r][c] = value;
  state.consensus.revision += 1;
  state.consensus.confirmations = {speaker:null, listener:null};
  state.consensus.actions.push({
    opId:opId || crypto.randomUUID(),
    baseRevision:Number.isInteger(baseRevision) ? baseRevision : state.consensus.revision - 1,
    revision:state.consensus.revision,
    actor:actor,
    r:r, c:c, from:from, value:value,
    tApplied:isoTime(Date.now())
  });
  sendConsensusState();
  save();
}

function doConsensusToggle(r, c){
  if(!state || state.status !== "consensus") return;
  if(MODE === "online" && !net.connected) return;
  var value = state.consensus.rows[r][c] ? 0 : 1;
  var opId = crypto.randomUUID();
  if(MODE === "online" && myRole === "listener"){
    sendMsg({
      type:"consensus_edit_request",
      opId:opId,
      baseRevision:state.consensus.revision,
      r:r, c:c, value:value,
      actor:"listener"
    });
    return;
  }
  applyConsensusEdit(r, c, value, roleNow(), opId, state.consensus.revision);
}

function applyConsensusConfirmation(role, revision){
  if(!isSpeakerAuthority() || state.status !== "consensus") return;
  if(role !== "speaker" && role !== "listener") return;
  if(revision !== state.consensus.revision){ sendConsensusState(); return; }
  state.consensus.confirmations[role] = {
    revision:revision,
    confirmedAt:isoTime(Date.now())
  };
  if(state.consensus.confirmations.speaker && state.consensus.confirmations.listener &&
     state.consensus.confirmations.speaker.revision === state.consensus.revision &&
     state.consensus.confirmations.listener.revision === state.consensus.revision){
    finishTrialAuthority();
    return;
  }
  sendConsensusState();
  save();
}

function confirmConsensus(){
  if(!state || state.status !== "consensus") return;
  if(MODE === "solo"){
    var now = isoTime(Date.now());
    state.consensus.confirmations = {
      speaker:{revision:state.consensus.revision, confirmedAt:now},
      listener:{revision:state.consensus.revision, confirmedAt:now}
    };
    finishTrialAuthority();
    return;
  }
  if(myRole === "listener"){
    sendMsg({type:"consensus_confirm_request", role:"listener", revision:state.consensus.revision});
  }else{
    applyConsensusConfirmation("speaker", state.consensus.revision);
  }
}

function finishTrialAuthority(){
  if(!isSpeakerAuthority() || !state || state.status !== "consensus") return;
  state.status = "complete";
  state.phase = "complete";
  state.completedAt = isoTime(Date.now());
  state.consensus.submittedAt = state.completedAt;
  var payload = buildTrialPayload();
  state.completedPayload = payload;
  if(MODE === "online") sendMsg({type:"trial_complete", payload:payload});
  save();
  uploadCompletedTrial();
}

async function uploadCompletedTrial(){
  if(!state || state.status !== "complete" || !isSpeakerAuthority()) return;
  if(!API_BASE){
    state.upload.status = "local_only";
    state.upload.lastError = "No collection server configured";
    render();
    return;
  }
  state.upload.status = "uploading";
  state.upload.lastError = null;
  render();
  var handle = await ensureServerTrial();
  if(!handle){
    state.upload.status = "error";
    state.upload.lastError = state.upload.lastError || "Could not obtain a write token";
    render();
    return;
  }
  try{
    var payload = buildTrialPayload();
    payload.trialId = handle.trialId;
    var response = await fetch(apiURL("/api/trials/") + encodeURIComponent(handle.trialId), {
      method:"PUT",
      headers:{
        "Content-Type":"application/json",
        Authorization:"Bearer " + handle.writeToken
      },
      body:JSON.stringify(payload)
    });
    var data = await response.json().catch(function(){ return {}; });
    if(!response.ok) throw new Error(data.error && data.error.message || "Upload failed");
    state.upload.status = "uploaded";
    state.upload.uploadedAt = isoTime(Date.now());
    state.upload.lastError = null;
    render();
  }catch(error){
    state.upload.status = "error";
    state.upload.lastError = error.message;
    render();
  }
}

function initRoleState(role){
  if(role === "speaker") newSession(DEFAULT_PATTERN_ID);
  else state = blankOnlineState();
}

function sendMsg(message){
  if(!net.conn || !net.connected) return false;
  var envelope = Object.assign({
    v:PEER_PROTOCOL_VERSION,
    trialId:state && state.trialId || null,
    sentAt:isoTime(Date.now())
  }, message);
  try{ net.conn.send(envelope); return true; }catch(e){ return false; }
}

function sendStart(){
  sendPublicSync();
}

function sendPublicSync(){
  if(!state || myRole !== "speaker") return;
  if(state.status === "complete"){
    sendMsg({type:"trial_complete", payload:state.completedPayload || buildTrialPayload()});
    return;
  }
  if(state.status === "consensus"){
    sendMsg({
      type:"consensus_start",
      source:currentSource(),
      ending:state.ending,
      consensus:publicConsensusState()
    });
    return;
  }
  var listenerActive = state.phase === "listener_turn" || state.phase === "speaker_predict";
  sendMsg({
    type:"start",
    rows:12, cols:12,
    status:state.status,
    roundNum:state.roundNum,
    phase:listenerActive ? "listener_turn" : state.phase,
    instruction:listenerActive ? state.instruction : "",
    committed:state.committed,
    ending:state.status === "end_pending" ? state.ending : null
  });
}

function installConsensusMessage(message){
  var incoming = message.consensus || {};
  var rows = incoming.rows;
  if(!validRows(rows)) return false;
  state.consensus = {
    rows:rowsToGrid(rows),
    revision:Number.isInteger(incoming.revision) ? incoming.revision : 0,
    actions:Array.isArray(incoming.actions) ? incoming.actions : [],
    confirmations:incoming.confirmations || {speaker:null,listener:null},
    submittedAt:incoming.submittedAt || null
  };
  return true;
}

function onMessage(message){
  if(!message || !message.type) return;
  if(message.v !== undefined && message.v !== PEER_PROTOCOL_VERSION) return;
  if(!["hello","start"].includes(message.type) && state && state.trialId && message.trialId !== state.trialId) return;
  switch(message.type){
    case "hello":
      if(!net.isHost){
        var correct = opposite(message.role);
        if(correct !== myRole){ myRole = correct; initRoleState(myRole); }
        net.roleConfirmed = true;
      }
      if(myRole === "speaker") sendPublicSync();
      render();
      break;
    case "start":
      if(myRole !== "listener") break;
      if(!state) state = blankOnlineState();
      if(state.trialId && state.trialId !== message.trialId) break;
      state.trialId = message.trialId;
      if(state.roundNum > message.roundNum) break;
      if(state.phase === "listener_turn" && state.pending.length) break;
      if(validGrid(message.committed)){
        state.committed = clone(message.committed);
        state.design = clone(message.committed);
      }
      state.roundNum = message.roundNum;
      state.phase = message.phase;
      state.status = message.status || "communicating";
      state.instruction = message.instruction || "";
      if(message.ending) state.ending = message.ending;
      render();
      break;
    case "instruction":
      if(myRole !== "listener" || state.status !== "communicating") break;
      state.instruction = String(message.text || "");
      state.roundNum = message.round;
      state.roundStartRows = clone(state.committed);
      state.design = clone(state.committed);
      state.phase = "listener_turn";
      state.pending = [];
      state.awaitingRoundAck = false;
      render();
      break;
    case "submit":
      if(myRole !== "speaker" || state.status !== "communicating" || !validGrid(message.design)) break;
      if(state.phase === "speaker_predict"){
        state.pendingSubmit = {design:message.design, actions:Array.isArray(message.actions) ? message.actions : [], round:message.round};
        render();
        break;
      }
      if(state.phase !== "listener_turn" || message.round !== state.roundNum) break;
      recordSubmission(message.design, Array.isArray(message.actions) ? message.actions : [], message.round);
      break;
    case "round_ack":
      if(myRole !== "listener" || message.round !== state.roundNum) break;
      if(validGrid(message.committed)){
        state.committed = clone(message.committed);
        state.design = clone(message.committed);
      }
      state.roundNum = message.nextRound;
      state.instruction = "";
      state.phase = "speaker_turn";
      state.awaitingRoundAck = false;
      render();
      break;
    case "end_request":
      if(state.status !== "communicating" || !message.request) break;
      state.status = "end_pending";
      state.ending = Object.assign(initialEnding(), message.request);
      render();
      break;
    case "end_cancel":
      if(state.status !== "end_pending") break;
      state.status = "communicating";
      state.ending = initialEnding();
      render();
      break;
    case "end_response":
      if(state.status !== "end_pending") break;
      if(!message.accepted){
        state.status = "communicating";
        state.ending = initialEnding();
        render();
        break;
      }
      state.ending.confirmedBy = message.by;
      state.ending.confirmedAt = message.at || isoTime(Date.now());
      if(myRole === "speaker") beginConsensusAuthority();
      else render();
      break;
    case "consensus_start":
      if(myRole !== "listener" || !message.source) break;
      state.patternId = message.source.id || null;
      state.revealedSource = message.source;
      state.ending = message.ending || state.ending;
      state.status = "consensus";
      state.phase = "consensus";
      installConsensusMessage(message);
      render();
      break;
    case "consensus_edit_request":
      if(myRole !== "speaker" || state.status !== "consensus") break;
      applyConsensusEdit(message.r, message.c, message.value, "listener", message.opId, message.baseRevision);
      break;
    case "consensus_state":
      if(myRole !== "listener" || !["consensus","complete"].includes(state.status)) break;
      if(!installConsensusMessage(message)) break;
      state.status = message.status || state.status;
      state.completedAt = message.completedAt || state.completedAt;
      render();
      break;
    case "consensus_confirm_request":
      if(myRole !== "speaker" || state.status !== "consensus") break;
      applyConsensusConfirmation("listener", message.revision);
      break;
    case "trial_complete":
      if(myRole !== "listener" || !message.payload) break;
      state.completedPayload = message.payload;
      state.status = "complete";
      state.phase = "complete";
      state.completedAt = message.payload.completedAt || isoTime(Date.now());
      state.revealedSource = message.payload.source || state.revealedSource;
      state.rounds = Array.isArray(message.payload.rounds) ? message.payload.rounds : state.rounds;
      state.patternId = state.revealedSource && state.revealedSource.id || state.patternId;
      if(message.payload.consensus && validRows(message.payload.consensus.rows)){
        state.consensus.rows = rowsToGrid(message.payload.consensus.rows);
        state.consensus.revision = message.payload.consensus.revision || state.consensus.revision;
        state.consensus.actions = message.payload.consensus.actions || [];
        state.consensus.confirmations = message.payload.consensus.confirmations || state.consensus.confirmations;
        state.consensus.submittedAt = message.payload.consensus.submittedAt || state.completedAt;
      }
      render();
      break;
  }
}

function leaveRoom(){
  stopAndDiscardSpeech();
  net.everConnected = false;
  try{ if(net.conn) net.conn.close(); }catch(e){}
  try{ if(net.peer) net.peer.destroy(); }catch(e){}
  location.href = location.origin + location.pathname;
}

function sourceStimulusHTML(source){
  if(!source || !source.iconDataUri) return '<div class="empty-note">Source image unavailable.</div>';
  var attribution = source.attribution || {};
  var credit = "";
  if(attribution.author){
    var author = escapeHtml(attribution.author);
    if(attribution.authorUrl){
      author = '<a href="' + escapeHtml(attribution.authorUrl) + '" target="_blank" rel="noopener noreferrer">' + author + '</a>';
    }
    credit = '<div class="icon-credit">Icon by ' + author;
    if(attribution.sourceUrl){
      credit += ' · <a href="' + escapeHtml(attribution.sourceUrl) + '" target="_blank" rel="noopener noreferrer">source</a>';
    }
    credit += "</div>";
  }
  return '<div class="stimA-wrap">' +
    '<img class="stimA" src="' + source.iconDataUri + '" alt="source image">' +
    '<div class="sub" style="margin-top:6px;">Create a 12×12 bead interpretation of this image.</div>' +
    credit + "</div>";
}

function targetStimulusHTML(){
  return sourceStimulusHTML(currentSource());
}

function transcriptionControlsHTML(canSend){
  var busy = ["connecting","recording","finalizing"].includes(speech.status);
  var recording = ["connecting","recording"].includes(speech.status);
  var button = recording
    ? '<button class="btn warn" id="micStopBtn" type="button">■ Stop</button>'
    : '<button class="btn" id="micStartBtn" type="button"' + (!canSend || !API_BASE ? " disabled" : "") + '>🎙 Start voice</button>';
  return '<div class="speechbar">' +
    '<select id="speechLang" aria-label="Speech language"' + (busy ? " disabled" : "") + '>' +
      '<option value="auto"' + (draftLanguage === "auto" ? " selected" : "") + '>中文 + English</option>' +
      '<option value="zh"' + (draftLanguage === "zh" ? " selected" : "") + '>中文</option>' +
      '<option value="en"' + (draftLanguage === "en" ? " selected" : "") + '>English</option>' +
    "</select>" + button +
    '<span class="speech-status ' + speech.status + '" id="speechStatus"></span></div>';
}

function endControlHTML(){
  var available = stableRoundBoundary() && (MODE !== "online" || net.connected);
  return '<div class="phase-card">' +
    '<div><strong>Reached the communication limit?</strong></div>' +
    '<div class="sub" style="margin:0;">Either participant may request the end. The other must confirm before the source image is revealed.</div>' +
    '<button class="btn warn" id="requestEndBtn"' + (available ? "" : " disabled") + '>End communication…</button>' +
  "</div>";
}

function speakerPanel(){
  var netBlock = MODE === "online" && !net.connected;
  var canSend = state.status === "communicating" && state.phase === "speaker_turn" && !netBlock;
  var predicting = state.status === "communicating" && state.phase === "speaker_predict";
  var lastRound = state.rounds[state.rounds.length - 1];
  var history = state.rounds.length ? state.rounds.map(function(round){
    var text = round.instruction && round.instruction.sentText || "";
    var gap = round.metrics && round.metrics.predictionListenerGap;
    return '<div class="hrow"><span class="n">' + round.index + '</span>' +
      '<span class="t" title="' + escapeHtml(text) + '">' + escapeHtml(text) + '</span>' +
      '<span class="a">' + (round.listener && round.listener.actions ? round.listener.actions.length : 0) + ' ops</span>' +
      '<span class="d">' + (gap !== null && gap !== undefined ? "Δ=" + gap : "") + "</span></div>";
  }).join("") : '<div class="empty-note">No completed rounds yet.</div>';
  var actionBlock;
  if(predicting){
    actionBlock = '<div class="instr-in">' +
      '<div class="sub" style="margin:0;">You sent round ' + state.roundNum + ":</div>" +
      '<div class="instr-show">' + escapeHtml(state.instruction) + "</div>" +
      '<div class="sub" style="margin:6px 0 0;">Draw the board you expect the Listener to build before seeing their submission.</div>' +
      gridHTML(state.prediction, {live:!netBlock, edit:"prediction"}) +
      '<div class="stats">' +
        '<div class="stat"><div class="k">PREDICTED BEADS</div><div class="v">' + count(state.prediction) + "</div></div>" +
        '<div class="stat"><div class="k">EDITS</div><div class="v">' + state.predictionPending.length + "</div></div>" +
        '<div class="stat"><div class="k">ROUND</div><div class="v">' + state.roundNum + "</div></div>" +
      "</div>" +
      (state.pendingSubmit ? '<div class="tut-hint" style="color:var(--mod)">Listener submitted; confirm your forecast to reveal it.</div>' : "") +
      '<button class="btn go" id="confirmPredBtn"' + (netBlock ? " disabled" : "") + '>Confirm prediction →</button></div>';
  }else{
    var speechBusy = ["connecting","recording","finalizing"].includes(speech.status);
    actionBlock = '<div class="instr-in">' +
      '<div class="sub" style="margin:0;">' + (canSend ? "Round " + state.roundNum + ": speak or type one instruction" : "Waiting for the Listener…") + "</div>" +
      transcriptionControlsHTML(canSend) +
      '<textarea id="instrBox" placeholder="Speak, or type an instruction here…"' + (canSend && !speechBusy ? "" : " disabled") + '>' + escapeHtml(draftInstr) + "</textarea>" +
      '<button class="btn go" id="sendBtn"' + (canSend && !speechBusy ? "" : " disabled") + '>Confirm text &amp; send →</button></div>';
  }
  return '<div class="panel">' +
    '<h2><span class="tag sp">SPEAKER</span> Source &amp; communication</h2>' +
    '<div class="sub">You see only the normal source image during communication. No pre-converted bead answer is in this participant page.</div>' +
    '<div class="row" style="align-items:flex-start;gap:14px;">' +
      '<div style="flex:1;"><div class="sub" style="margin:0 0 6px;">SOURCE IMAGE</div>' + targetStimulusHTML() + "</div>" +
      '<div style="flex:1;"><div class="sub" style="margin:0 0 6px;">LISTENER LATEST</div>' + gridHTML(state.committed) + "</div>" +
    "</div>" +
    '<div class="stats">' +
      '<div class="stat"><div class="k">LISTENER BEADS</div><div class="v">' + count(state.committed) + "</div></div>" +
      '<div class="stat"><div class="k">LAST Δ</div><div class="v">' + (lastRound && lastRound.metrics.predictionListenerGap !== null ? lastRound.metrics.predictionListenerGap : "—") + "</div></div>" +
      '<div class="stat"><div class="k">ROUNDS DONE</div><div class="v">' + state.rounds.length + "</div></div>" +
    '</div><div class="divider"></div>' + actionBlock +
    '<div class="divider"></div><div class="sub" style="margin:0;">History · Δ = forecast vs actual</div>' +
    '<div class="hist">' + history + "</div>" +
    endControlHTML() +
  "</div>";
}

function listenerPanel(){
  var netBlock = MODE === "online" && !net.connected;
  var active = state.status === "communicating" && state.phase === "listener_turn" && !netBlock;
  var instruction = state.instruction
    ? '<div class="instr-show">' + escapeHtml(state.instruction) + "</div>"
    : '<div class="instr-show empty">Waiting for the Speaker instruction…</div>';
  var waiting = state.phase === "awaiting_round_ack"
    ? "Submitted. Waiting for the Speaker to confirm this round."
    : "Wait for the next instruction.";
  return '<div class="panel">' +
    '<h2><span class="tag li">LISTENER</span> Place beads</h2>' +
    '<div class="sub">During communication you cannot see the source image. Follow only the confirmed text.</div>' +
    '<div class="sub" style="margin:0;">THIS ROUND INSTRUCTION</div>' + instruction +
    gridHTML(state.design, {live:active, locked:!active}) +
    '<div class="stats">' +
      '<div class="stat"><div class="k">BEADS</div><div class="v">' + count(state.design) + "</div></div>" +
      '<div class="stat"><div class="k">OPS</div><div class="v">' + state.pending.length + "</div></div>" +
      '<div class="stat"><div class="k">ROUND</div><div class="v">' + state.roundNum + "</div></div>" +
    "</div>" +
    '<button class="btn go" id="submitBtn"' + (active ? "" : " disabled") + '>Submit round ✓</button>' +
    (active ? "" : '<div class="empty-note">' + waiting + "</div>") +
    (myRole === "listener" ? endControlHTML() : "") +
  "</div>";
}

function endPendingPanel(){
  var actor = roleNow() === "both" ? "speaker" : roleNow();
  var requester = state.ending.requestedBy || "participant";
  var isRequester = MODE === "online" && actor === requester;
  var waiting = state.ending.confirmedBy && !state.ending.targetRevealedAt;
  var controls;
  if(MODE === "solo"){
    controls = '<button class="btn go" id="acceptEndBtn">Confirm end &amp; reveal source →</button>' +
      '<button class="btn" id="cancelEndBtn">Keep communicating</button>';
  }else if(isRequester){
    controls = '<div class="empty-note">' + (waiting ? "Confirmed. Waiting for the Speaker authority to open consensus…" : "Waiting for the other participant to confirm…") + "</div>" +
      '<button class="btn" id="cancelEndBtn"' + (waiting ? " disabled" : "") + '>Cancel request</button>';
  }else{
    controls = '<button class="btn go" id="acceptEndBtn">Confirm end &amp; reveal source</button>' +
      '<button class="btn" id="declineEndBtn">Continue communicating</button>';
  }
  return '<div class="panel consensus-panel"><h2>End communication?</h2>' +
    '<div class="phase-card"><div><strong>' + escapeHtml(requester) + '</strong> requested the end.</div>' +
    '<div class="sub" style="margin:0;">Confirming freezes the Listener final communication board. Only then will the Listener receive the normal source image. The shared answer starts blank.</div>' +
    controls + "</div></div>";
}

function consensusPanel(completed){
  var consensus = state.consensus;
  var editable = !completed && (MODE !== "online" || net.connected);
  var speakerConfirmed = consensus.confirmations.speaker && consensus.confirmations.speaker.revision === consensus.revision;
  var listenerConfirmed = consensus.confirmations.listener && consensus.confirmations.listener.revision === consensus.revision;
  var myConfirmed = MODE === "solo" ? speakerConfirmed && listenerConfirmed :
    (myRole === "speaker" ? speakerConfirmed : listenerConfirmed);
  var status = state.upload || {};
  var uploadText = status.status === "uploaded" ? "Uploaded to the private research collection." :
    status.status === "uploading" ? "Uploading completed trial…" :
    status.status === "error" ? "Upload failed: " + (status.lastError || "unknown error") :
    "JSON is available for download." ;
  return '<div class="panel consensus-panel">' +
    '<h2>' + (completed ? "Trial complete · Pair consensus" : "Post-reveal pair consensus") + "</h2>" +
    '<div class="sub">' + (completed
      ? "This is the pair final 12×12 interpretation."
      : "The source is now visible to both people. This grid began completely blank; every edit below belongs to the consensus stage.") + "</div>" +
    '<div class="consensus-layout">' +
      '<div><div class="sub" style="margin:0 0 6px;">NORMAL SOURCE IMAGE</div>' + sourceStimulusHTML(currentSource()) + "</div>" +
      '<div><div class="sub" style="margin:0 0 6px;">PAIR CONSENSUS · revision ' + consensus.revision + "</div>" +
        gridHTML(consensus.rows, {live:editable, edit:"consensus", locked:!editable}) +
        '<div class="stats">' +
          '<div class="stat"><div class="k">BEADS</div><div class="v">' + count(consensus.rows) + "</div></div>" +
          '<div class="stat"><div class="k">EDITS</div><div class="v">' + consensus.actions.length + "</div></div>" +
          '<div class="stat"><div class="k">ROUNDS</div><div class="v">' + state.rounds.length + "</div></div>" +
        "</div>" +
      "</div>" +
    "</div>" +
    '<div class="confirm-grid">' +
      '<div class="confirm-chip' + (speakerConfirmed ? " on" : "") + '">Speaker ' + (speakerConfirmed ? "✓ confirmed" : "not confirmed") + "</div>" +
      '<div class="confirm-chip' + (listenerConfirmed ? " on" : "") + '">Listener ' + (listenerConfirmed ? "✓ confirmed" : "not confirmed") + "</div>" +
    "</div>" +
    (!completed
      ? '<button class="btn go" id="confirmConsensusBtn"' + (myConfirmed || !editable ? " disabled" : "") + '>' +
          (myConfirmed ? "Confirmed — waiting for partner" : MODE === "solo" ? "Confirm final pair answer" : "Confirm this revision") + "</button>"
      : '<div class="row"><button class="btn go" id="downloadCompleteBtn">Download trial JSON</button>' +
          (status.status === "error" ? '<button class="btn" id="retryUploadBtn">Retry upload</button>' : "") + "</div>" +
        '<div class="upload-note">' + escapeHtml(uploadText) + "</div>") +
  "</div>";
}

function render(){
  if(!state) return;
  document.getElementById("roundNum").textContent = state.roundNum || 1;
  var pill = document.getElementById("phasePill");
  var hint = document.getElementById("phaseHint");
  if(state.status === "end_pending"){
    pill.className = "pill speaker"; pill.textContent = "END REQUESTED";
    hint.textContent = "→ Waiting for both participants";
  }else if(state.status === "consensus"){
    pill.className = "pill listener"; pill.textContent = "PAIR CONSENSUS";
    hint.textContent = "→ Source revealed · build a new shared 12×12 answer";
  }else if(state.status === "complete"){
    pill.className = "pill listener"; pill.textContent = "TRIAL COMPLETE";
    hint.textContent = "→ Downloaded or uploaded as one complete trial";
  }else if(state.phase === "speaker_turn"){
    pill.className = "pill speaker"; pill.textContent = "SPEAKER turn";
    hint.textContent = "→ Speak or type an instruction";
  }else if(state.phase === "speaker_predict"){
    pill.className = "pill speaker"; pill.textContent = "SPEAKER predicts";
    hint.textContent = "→ Forecast before seeing the Listener result";
  }else{
    pill.className = "pill listener"; pill.textContent = state.phase === "awaiting_round_ack" ? "ROUND SUBMITTED" : "LISTENER turn";
    hint.textContent = state.phase === "awaiting_round_ack" ? "→ Waiting for confirmation" : "→ Build from the confirmed text";
  }

  var online = MODE === "online";
  document.getElementById("roleGrp").style.display = online ? "none" : "";
  document.getElementById("patternGrp").style.display = online && myRole !== "speaker" ? "none" : "";
  document.getElementById("resetBtn").style.display = online && myRole !== "speaker" ? "none" : "";
  document.getElementById("onlineBtn").style.display = online ? "none" : "";
  document.getElementById("leaveBtn").style.display = online ? "" : "none";
  if(!online){
    document.querySelectorAll("#roleSeg button").forEach(function(button){
      button.classList.toggle("on", button.dataset.role === myRole);
    });
    if(state.patternId) document.getElementById("patternSel").value = state.patternId;
  }
  var pillNet = document.getElementById("netPill");
  var netText = document.getElementById("netTxt");
  var labels = {local:"Local",waiting:"Waiting for partner",connecting:"Connecting…",connected:"Connected",disconnected:"Disconnected"};
  pillNet.className = "netpill " + net.status;
  netText.textContent = online ? (labels[net.status] || net.status) + " · " + myRole : "Local";

  var body;
  if(online && net.status === "connecting" && !net.connected) body = connectingPanel();
  else if(online && net.status === "disconnected" && !net.everConnected) body = errorPanel();
  else if(state.status === "end_pending") body = endPendingPanel();
  else if(state.status === "consensus") body = consensusPanel(false);
  else if(state.status === "complete") body = consensusPanel(true);
  else if(myRole === "speaker") body = speakerPanel();
  else if(myRole === "listener") body = listenerPanel();
  else body = speakerPanel() + listenerPanel();

  var banner = online && !net.connected && net.everConnected
    ? '<div class="disc-banner">⚠ Connection lost — editing is paused. <button class="btn" id="bannerLeave">Leave room</button></div>'
    : "";
  app.innerHTML = banner + body;

  var send = document.getElementById("sendBtn");
  if(send) send.onclick = function(){ doSend(document.getElementById("instrBox").value); };
  var box = document.getElementById("instrBox");
  if(box){
    box.oninput = function(){ draftInstr = box.value; };
    box.onkeydown = function(event){
      if(event.key === "Enter" && !event.shiftKey){ event.preventDefault(); doSend(box.value); }
    };
  }
  var speechLang = document.getElementById("speechLang");
  if(speechLang) speechLang.onchange = function(){ draftLanguage = speechLang.value; };
  var micStart = document.getElementById("micStartBtn");
  if(micStart) micStart.onclick = startTranscription;
  var micStop = document.getElementById("micStopBtn");
  if(micStop) micStop.onclick = stopTranscription;
  updateSpeechStatusDOM();
  var submit = document.getElementById("submitBtn");
  if(submit) submit.onclick = doSubmit;
  var prediction = document.getElementById("confirmPredBtn");
  if(prediction) prediction.onclick = confirmPrediction;
  var requestEnd = document.getElementById("requestEndBtn");
  if(requestEnd) requestEnd.onclick = requestTrialEnd;
  var acceptEnd = document.getElementById("acceptEndBtn");
  if(acceptEnd) acceptEnd.onclick = acceptEndRequest;
  var cancelEnd = document.getElementById("cancelEndBtn");
  if(cancelEnd) cancelEnd.onclick = cancelEndRequest;
  var declineEnd = document.getElementById("declineEndBtn");
  if(declineEnd) declineEnd.onclick = declineEndRequest;
  var confirmFinal = document.getElementById("confirmConsensusBtn");
  if(confirmFinal) confirmFinal.onclick = confirmConsensus;
  var download = document.getElementById("downloadCompleteBtn");
  if(download) download.onclick = exportJSON;
  var retryUpload = document.getElementById("retryUploadBtn");
  if(retryUpload) retryUpload.onclick = uploadCompletedTrial;
  var retry = document.getElementById("retryBtn");
  if(retry) retry.onclick = function(){ fallbackSolo(); showRoomModal(); };
  var solo = document.getElementById("soloBtn");
  if(solo) solo.onclick = function(){ fallbackSolo("Playing solo"); };
  var leave = document.getElementById("bannerLeave");
  if(leave) leave.onclick = leaveRoom;
}

function normalizedRoundForPayload(round, consensusGrid){
  var listenerGrid = round.listener && validRows(round.listener.submittedRows)
    ? rowsToGrid(round.listener.submittedRows) : round.designAfter;
  var predictionGrid = round.speakerPrediction && validRows(round.speakerPrediction.rows)
    ? rowsToGrid(round.speakerPrediction.rows) : round.prediction;
  var postHoc = null;
  if(consensusGrid && listenerGrid){
    postHoc = {
      listenerHammingToConsensus:hamming(listenerGrid, consensusGrid),
      predictionHammingToConsensus:predictionGrid ? hamming(predictionGrid, consensusGrid) : null
    };
  }
  return {
    id:round.id || "r" + (round.index || round.round),
    index:round.index || round.round,
    instruction:Object.assign({}, round.instruction),
    speakerPrediction:{
      rows:predictionGrid ? gridToRows(predictionGrid) : null,
      submittedAt:round.speakerPrediction && round.speakerPrediction.submittedAt || null,
      actions:round.speakerPrediction && round.speakerPrediction.actions || []
    },
    listener:{
      startRows:round.listener && round.listener.startRows || null,
      submittedRows:listenerGrid ? gridToRows(listenerGrid) : null,
      submittedAt:round.listener && round.listener.submittedAt || null,
      actions:round.listener && round.listener.actions || []
    },
    metrics:{
      predictionListenerGap:round.metrics && round.metrics.predictionListenerGap !== undefined
        ? round.metrics.predictionListenerGap : round.predListenerGap
    },
    postHocMetrics:postHoc
  };
}

function buildTrialPayload(){
  if(state.status === "complete" && state.completedPayload) return state.completedPayload;
  var complete = state.status === "complete";
  var consensusGrid = complete && state.consensus ? state.consensus.rows : null;
  var source = complete || isSpeakerAuthority() ? currentSource() : null;
  return {
    schemaVersion:TRIAL_SCHEMA_VERSION,
    experimentId:EXPERIMENT_ID,
    sessionId:state.sessionId,
    trialId:state.trialId,
    mode:MODE,
    roomCode:MODE === "online" ? net.code : null,
    status:complete ? "completed" : state.status,
    appVersion:APP_VERSION,
    protocolVersion:PEER_PROTOCOL_VERSION,
    source:source,
    gridSize:{rows:12, cols:12},
    participants:{speakerId:null, listenerId:null},
    startedAt:isoTime(state.startedAt),
    rounds:state.rounds.map(function(round){ return normalizedRoundForPayload(round, consensusGrid); }),
    ending:{
      requestedBy:state.ending.requestedBy,
      requestedAt:state.ending.requestedAt,
      confirmedBy:state.ending.confirmedBy,
      confirmedAt:state.ending.confirmedAt,
      communicationFinalRows:state.ending.communicationFinalRows,
      targetRevealedAt:state.ending.targetRevealedAt
    },
    consensus:{
      initialGrid:"blank",
      rows:state.consensus ? gridToRows(state.consensus.rows) : null,
      revision:state.consensus && state.consensus.revision || 0,
      actions:state.consensus && state.consensus.actions || [],
      confirmations:state.consensus && state.consensus.confirmations || {speaker:null,listener:null},
      submittedAt:state.consensus && state.consensus.submittedAt || null
    },
    completedAt:state.completedAt,
    exportedAt:isoTime(Date.now())
  };
}

function exportJSON(){
  if(!state) return;
  var payload = buildTrialPayload();
  var blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  var anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "perler_trial_" + (state.patternId || "unrevealed") + "_" + Date.now() + ".json";
  anchor.click();
  setTimeout(function(){ URL.revokeObjectURL(anchor.href); }, 0);
  toast("Trial JSON downloaded");
}

function gridFromRoundRows(rows, fallback){
  return validRows(rows) ? rowsToGrid(rows) : fallback;
}

function exportPNGSheet(){
  var payload = buildTrialPayload();
  var rounds = payload.rounds || [];
  var finalGrid = payload.consensus && validRows(payload.consensus.rows)
    ? rowsToGrid(payload.consensus.rows) : state.committed;
  var cell = 12, gap = 2, pad = 18, columnGap = 24, labelHeight = 18, rowGap = 18, titleHeight = 24;
  var gridWidth = 12 * cell + 13 * gap;
  var gridHeight = gridWidth;
  var rowsCount = Math.max(1, rounds.length + (state.status === "complete" ? 1 : 0));
  var width = pad * 2 + gridWidth * 2 + columnGap;
  var height = pad + titleHeight + rowsCount * (labelHeight + gridHeight + rowGap) + pad;
  var canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  var context = canvas.getContext("2d");
  context.fillStyle = "#0f1115"; context.fillRect(0,0,width,height);
  context.textBaseline = "top";
  context.fillStyle = "#e9edf3";
  context.font = "bold 15px -apple-system,Segoe UI,sans-serif";
  context.fillText(payload.source && payload.source.name || "Perler trial", pad, pad);
  var y = pad + titleHeight;
  rounds.forEach(function(round){
    context.fillStyle = "#9aa4b2";
    context.font = "12px -apple-system,Segoe UI,sans-serif";
    context.fillText("Round " + round.index + " · forecast / Listener", pad, y);
    y += labelHeight;
    var prediction = gridFromRoundRows(round.speakerPrediction && round.speakerPrediction.rows, zerosDim(12,12));
    var listener = gridFromRoundRows(round.listener && round.listener.submittedRows, zerosDim(12,12));
    paintGrid(context, prediction, pad, y, {cell:cell,gap:gap,on:"#F2A63B"});
    paintGrid(context, listener, pad + gridWidth + columnGap, y, {cell:cell,gap:gap});
    y += gridHeight + rowGap;
  });
  if(state.status === "complete"){
    context.fillStyle = "#9aa4b2";
    context.fillText("Final pair consensus", pad, y);
    y += labelHeight;
    paintGrid(context, finalGrid, pad, y, {cell:cell,gap:gap,on:"#4FBF8B"});
  }
  downloadDataURI(canvas.toDataURL("image/png"), "perler_trial_sheet_" + Date.now() + ".png");
  toast("PNG timeline downloaded");
}

function showRoomInfo(code, role){
  document.getElementById("roomCreate").style.display = "none";
  document.getElementById("roomInfo").style.display = "";
  document.getElementById("rcCode").textContent = code;
  var query = "?room=" + encodeURIComponent(code) + "&as=" + encodeURIComponent(opposite(role));
  if(EXPLICIT_API_BASE) query += "&api=" + encodeURIComponent(EXPLICIT_API_BASE);
  var link = location.origin + location.pathname + query;
  document.getElementById("rcLink").value = link;
  document.getElementById("rcStatus").textContent = "Waiting for the other player to join as " + opposite(role) + "…";
  roomModal.classList.add("show");
}

document.getElementById("exportBtn").onclick = exportJSON;
document.getElementById("pngBtn").onclick = exportPNGSheet;
document.getElementById("leaveBtn").onclick = leaveRoom;
var dashboard = document.getElementById("dashboardLink");
if(dashboard && EXPLICIT_API_BASE){
  dashboard.href = "research_dashboard.html?api=" + encodeURIComponent(EXPLICIT_API_BASE);
}
window.addEventListener("pagehide", stopAndDiscardSpeech);
