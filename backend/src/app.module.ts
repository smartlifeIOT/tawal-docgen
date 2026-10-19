import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './modules/storage/storage.module';
import { UplModule } from './modules/upl/upl.module';
import { GclModule } from './modules/gcl/gcl.module';
import { PackagesModule } from './modules/packages/packages.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ExternalProjectsModule } from './modules/external-projects/external-projects.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MopModule } from './modules/mop/mop.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { PmsAuthGuard } from './modules/auth/pms-auth.guard';
import { PermissionsGuard } from './modules/auth/permissions.guard';
import { DocxToPdfService } from './modules/mop/docx-to-pdf.service';
import { HealthController } from './modules/health/health.controller';
import { SiteTagsModule } from './modules/site-tags/site-tags.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 240 }]),
    PrismaModule,
    StorageModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    ExternalProjectsModule,
    ProjectsModule,
    DashboardModule,
    MopModule,
    UplModule,
    GclModule,
    SiteTagsModule,
    PackagesModule,
    DocumentsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Authentication is on for the whole platform. Routes opt out with @Public().
    /*
     * DocGen signs its own tokens and owns its own accounts, so this defaults
     * to standalone. Set AUTH_MODE=pms only when it genuinely runs behind PMS,
     * where PMS signs the tokens and is the system of record for permissions.
     *
     * This used to default to "pms". AUTH_MODE is set nowhere, so a standalone
     * deployment silently ran PmsAuthGuard, whose mirror() rewrote the user's
     * role and permissions from the token on every request — and DocGen's own
     * tokens carry no permissions claim, so each request reset the user back to
     * DEFAULT_PM_PERMISSIONS. Granting a permission appeared to do nothing.
     */
    {
      provide: APP_GUARD,
      useClass:
        (process.env.AUTH_MODE ?? 'standalone') === 'pms' ? PmsAuthGuard : JwtAuthGuard,
    },
    // Runs after authentication; routes opt in with @RequirePermission().
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // HealthController lives on this module and reports PDF-engine readiness.
    DocxToPdfService,
  ],
})
export class AppModule {}
