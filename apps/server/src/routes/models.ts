import { Router as ExpressRouter, type Router } from "express";
import { MODEL_REGISTRY, type ModelDefinition } from "../models/registry.js";

export const modelsRouter: Router = ExpressRouter();

modelsRouter.get("/", (_req, res) => {
  const data = Object.entries(MODEL_REGISTRY).map(([provider, models]) => ({
    provider,
    models: Object.entries(models).map(([id, def]) => {
      const model = def as ModelDefinition;
      const variants = [id];
      if (model.features.includes("thinking")) {
        variants.push(`${id}:thinking`);
      }
      return {
        id,
        name: model.name,
        variants,
        pricing: model.pricing,
        features: model.features,
      };
    }),
  }));

  res.json({ data });
});
