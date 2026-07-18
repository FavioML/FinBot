// Shape mínimo para los custom tooltips de Recharts v3. La librería tipa el prop
// `content` de <Tooltip> de forma laxa; este genérico da tipos concretos sin `any`.
// `T` es el datum original del chart (lo que Recharts expone en `payload[].payload`).
export interface ChartTooltipProps<T> {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    value?: number;
    name?: string;
    dataKey?: string | number;
    color?: string;
    payload: T;
  }>;
}
