import { OmitType } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuantitySource } from '@prisma/client';

/** Multipart bodies arrive as strings, so JSON/CSV fields need coercing. */
const asArray = ({ value }: { value: any }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return undefined;
      }
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
};

export class ScopeSiteInputDto {
  @IsString() siteCode!: string;
  @IsOptional() @IsString() siteNo?: string;
  @IsOptional() @IsString() woNumber?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() district?: string;
}

export class CreateGclDto {
  /** Restrict creation to these site codes; omit to take every site in the sheet. */
  @IsOptional() @Transform(asArray) @IsArray() @IsString({ each: true })
  siteCodes?: string[];

  @IsOptional() @Transform(asArray) @IsArray()
  @ValidateNested({ each: true }) @Type(() => ScopeSiteInputDto)
  sites?: ScopeSiteInputDto[];

  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() contractorName?: string;
  @IsOptional() @IsString() uplVersion?: string;
  @IsOptional() @IsString() woSequence?: string;
  /** Site ID of the tracker project. Required — see CreateFromGclDto. */
  @IsString({ message: 'Select a project before creating a GCL' })
  externalSiteId!: string;
  @IsOptional() @IsEnum(QuantitySource) quantitySource?: QuantitySource;
  /** Which parsed column drives pricing, e.g. "col12". */
  @IsOptional() @IsString() quantityFieldKey?: string;

  @IsOptional() @Type(() => Date) @IsDate() gclDate?: Date;
  @IsOptional() @Type(() => Date) @IsDate() handoverDate?: Date;
  @IsOptional() @Type(() => Date) @IsDate() startDate?: Date;
  @IsOptional() @Type(() => Date) @IsDate() endDate?: Date;
  @IsOptional() @Type(() => Date) @IsDate() mspSignDate?: Date;

  @IsOptional() @IsString() contractorPmName?: string;
  @IsOptional() @IsString() contractorPmId?: string;
  @IsOptional() @IsString() mspRepName?: string;
  @IsOptional() @IsString() tawalPmName?: string;
  @IsOptional() @IsString() tawalPmId?: string;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) poValue?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) foc?: number;

  @IsOptional() @IsString() notes?: string;

  @IsOptional() @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean() overwrite?: boolean;
}

/**
 * The same body, for the route that takes the project from the URL.
 *
 * A real class, not `Omit<CreateGclDto, …>`: a TypeScript type erases to
 * `Object` at runtime, and ValidationPipe skips anything it sees as `Object` —
 * so none of the @Transform coercions above would run, and a multipart
 * `overwrite=true` would stay the string "true" while `siteCodes` stayed raw
 * JSON. OmitType carries the decorators across.
 */
export class CreateGclFromProjectDto extends OmitType(CreateGclDto, [
  'externalSiteId',
] as const) {}
