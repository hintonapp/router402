import { Router as ExpressRouter, type Router } from "express";
import {
  SUPPORTED_MODELS,
  MODEL_CAPABILITIES,
  type SupportedModel,
} from "../providers/index.js";

export const modelsRouter: Router = ExpressRouter();

modelsRouter.get("/", (_req, res) => {
  const models = Object.keys(SUPPORTED_MODELS).map((key) => {
    const capabilities = MODEL_CAPABILITIES[key as SupportedModel];
    const variants = [key];
    if (capabilities?.thinking) {
      variants.push(`${key}:thinking`);
    }
    return {
      id: key,
      variants,
      capabilities,
    };
  });
  res.json({ data: models });
});
