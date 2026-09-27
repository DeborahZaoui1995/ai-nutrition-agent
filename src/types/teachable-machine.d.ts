export {};

declare global {
  interface TMPrediction {
    className: string;
    probability: number;
  }

  interface TMModel {
    getTotalClasses: () => number;
    predict: (
      input: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
    ) => Promise<TMPrediction[]>;
  }

  interface Window {
    tf?: unknown;
    tmImage?: {
      load: (modelUrl: string, metadataUrl: string) => Promise<TMModel>;
    };
  }
}
