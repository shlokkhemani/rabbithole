import { providerFor } from "./provider-registry.js";
import { discoverLocalModels } from "./local-model-catalog.js";

export const PDF_TRANSCRIPTION_HELP = "Uses a vision model to turn PDF pages into searchable Markdown.";

export function localVisionModels(models) {
  return (Array.isArray(models) ? models : []).filter((model) => model?.vision === true);
}

export function pdfTranscriptionCapability(settings, { models = null, discoveryError = false } = {}) {
  const preset = providerFor(settings?.preset);
  const configuredModel = String(settings?.transcribe_model || preset.transcribe_model || "").trim();
  if (preset.id !== "custom") {
    return configuredModel
      ? { available: true, status: "available", model: configuredModel, reason: "" }
      : { available: false, status: "model_required", model: "", reason: "Choose a PDF transcription model in Model settings." };
  }
  if (discoveryError) {
    return { available: false, status: "unverified", model: configuredModel, reason: "PDF transcription is disabled because Rabbithole couldn't verify a local vision model. Check the local endpoint in Model settings." };
  }
  if (!Array.isArray(models)) {
    return { available: false, status: "checking", model: configuredModel, reason: "Checking the local endpoint for a vision model…" };
  }
  if (!models.length) {
    return { available: false, status: "no_models", model: configuredModel, reason: "PDF transcription is disabled because no local models are installed." };
  }
  const visionModels = localVisionModels(models);
  const unknownModels = models.filter((model) => model?.vision == null);
  if (!visionModels.length) {
    const reason = unknownModels.length
      ? "PDF transcription is disabled because Rabbithole couldn't confirm that an installed local model supports vision."
      : "Install a local model that supports vision to enable PDF transcription.";
    return { available: false, status: unknownModels.length ? "unverified" : "no_vision", model: configuredModel, reason };
  }
  const selected = visionModels.find((model) => model.id === configuredModel);
  if (selected) return { available: true, status: "available", model: selected.id, reason: "", visionModels };
  const recommended = visionModels.find((model) => model.id === settings?.model) || visionModels[0];
  return {
    available: false,
    status: "model_required",
    model: configuredModel,
    recommendedModel: recommended.id,
    visionModels,
    reason: "Choose an installed vision model for PDF transcription in Model settings.",
  };
}

export async function detectPdfTranscriptionCapability(settings, { signal } = {}) {
  if (providerFor(settings?.preset).id !== "custom") return pdfTranscriptionCapability(settings);
  try {
    const models = await discoverLocalModels(settings?.base_url, { signal });
    return { ...pdfTranscriptionCapability(settings, { models }), models };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return pdfTranscriptionCapability(settings, { discoveryError: true });
  }
}
