self.__BUILD_MANIFEST = {
  "__rewrites": {
    "afterFiles": [
      {
        "source": "/mi-reporte/:id",
        "destination": "/mi-reporte"
      },
      {
        "source": "/api/reporte/:id",
        "destination": "/api/reporte/:id.json"
      }
    ],
    "beforeFiles": [],
    "fallback": []
  },
  "sortedPages": [
    "/_app",
    "/_error"
  ]
};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()