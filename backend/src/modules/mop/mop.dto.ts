import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { SiteImpact } from '@prisma/client';

export class CreateMopDto {
  /**
   * The tracker project this MOP is for. Optional: without one, the site or
   * project name is typed by hand and `projectCategoryId` decides the format.
   */
  @IsOptional() @IsString() externalSiteId?: string;

  /** Required when no project is selected — it is what resolves the format. */
  @IsOptional() @IsString() projectCategoryId?: string;
  @IsString() mopCategoryId!: string;
  @IsString() @MinLength(2, { message: 'Site ID is required' }) siteId!: string;
  @IsOptional() @IsString() tcnSummary?: string;
  @IsString() @MinLength(2, { message: 'Name of Requester is required' }) requesterName!: string;
  @IsString() @MinLength(2, { message: 'Name of PM is required' }) pmName!: string;
  @IsOptional() @IsEnum(SiteImpact) siteImpact?: SiteImpact;
  @IsOptional() @IsString() siteImpactNote?: string;
}

export class QueryMopDto {
  @IsOptional() @IsString() externalSiteId?: string;
  @IsOptional() @IsString() mopCategoryId?: string;
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() limit?: number;
}

export class BulkMopDto {
  /**
   * The tracker project this MOP is for. Optional: without one, the site or
   * project name is typed by hand and `projectCategoryId` decides the format.
   */
  @IsOptional() @IsString() externalSiteId?: string;

  /** Required when no project is selected — it is what resolves the format. */
  @IsOptional() @IsString() projectCategoryId?: string;
  @IsString() mopCategoryId!: string;
  /** Used for any row that leaves the column blank. */
  @IsOptional() @IsString() requesterName?: string;
  @IsOptional() @IsString() pmName?: string;
}
