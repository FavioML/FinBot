'use client';

import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CATEGORIAS } from '@/lib/constants';

const METODOS_PAGO = [
  { value: 'all', label: 'Todos los métodos' },
  { value: 'Debito', label: 'Débito' },
  { value: 'Credito', label: 'Crédito' },
  { value: 'Yape', label: 'Yape' },
  { value: 'Plin', label: 'Plin' },
  { value: 'Efectivo', label: 'Efectivo' },
];

interface TransactionFiltersProps {
  search: string;
  onSearchChange: (value: string | null) => void;
  tipoFilter: string;
  onTipoChange: (value: string | null) => void;
  categoriaFilter: string;
  onCategoriaChange: (value: string | null) => void;
  subcategoriaFilter: string;
  onSubcategoriaChange: (value: string | null) => void;
  metodoPagoFilter: string;
  onMetodoPagoChange: (value: string | null) => void;
}

export function TransactionFilters({
  search,
  onSearchChange,
  tipoFilter,
  onTipoChange,
  categoriaFilter,
  onCategoriaChange,
  subcategoriaFilter,
  onSubcategoriaChange,
  metodoPagoFilter,
  onMetodoPagoChange,
}: TransactionFiltersProps) {
  const selectedCat = CATEGORIAS.find((c) => c.nombre === categoriaFilter);
  const subcategorias = selectedCat ? selectedCat.subs : [];

  return (
    <div className="glass-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A877D]" />
          <Input
            placeholder="Buscar por comercio..."
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
            className="pl-8 bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#F0EFE8] placeholder:text-[#8A877D]"
          />
        </div>

        {/* Type tabs */}
        <Tabs value={tipoFilter} onValueChange={(val) => onTipoChange(val as string)}>
          <TabsList>
            <TabsTrigger value="todos">Todos</TabsTrigger>
            <TabsTrigger value="gasto">Gastos</TabsTrigger>
            <TabsTrigger value="ingreso">Ingresos</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Category filter */}
        <Select value={categoriaFilter} onValueChange={(val) => {
          onCategoriaChange(val);
          // Reset subcategory when category changes
          onSubcategoriaChange('all');
        }}>
          <SelectTrigger className="w-[180px] bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#C8C6BC]">
            <SelectValue placeholder="Todas las categorías" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las categorías</SelectItem>
            {CATEGORIAS.map((cat) => (
              <SelectItem key={cat.nombre} value={cat.nombre}>
                {cat.emoji} {cat.nombre}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Subcategory filter */}
        {categoriaFilter !== 'all' && subcategorias.length > 0 && (
          <Select value={subcategoriaFilter} onValueChange={onSubcategoriaChange}>
            <SelectTrigger className="w-[200px] bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#C8C6BC]">
              <SelectValue placeholder="Todas las subcategorías" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las subcategorías</SelectItem>
              {subcategorias.map((sub) => (
                <SelectItem key={sub} value={sub}>
                  {sub.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Payment method filter */}
        <Select value={metodoPagoFilter} onValueChange={onMetodoPagoChange}>
          <SelectTrigger className="w-[180px] bg-[rgba(255,255,255,0.03)] border-[rgba(255,255,255,0.06)] text-[#C8C6BC]">
            <SelectValue placeholder="Todos los métodos" />
          </SelectTrigger>
          <SelectContent>
            {METODOS_PAGO.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
