/**
 * Curated, human-language catalog of the client roles SKY LAB applications
 * check today. The Permissions view renders a role through this catalog; a
 * role that is not listed here is never shown as a headline permission and
 * only appears as a raw code inside the collapsed "Teknik ayrıntılar" block.
 *
 * Sources (read from each application's authorization code): core
 * `internal/authz`, forms-backend `HasRoleAsync("skyforms:*", "forms")` and
 * forms-frontend `resource_access.forms`, skymail-backend `RequireAnyPermission`,
 * cms-backend `RequireRole("cms:access")` per Site client. Superadmin
 * authorizes through core roles and Keycloak groups, so it has no roles of
 * its own here. The catalog is informational only: nothing in Account Center
 * grants or checks these roles.
 */

export type PermissionLabel = Readonly<{
  /** Short noun phrase shown as the row title. */
  label: string;
  /** One informal sentence explaining what the person can do. */
  description: string;
}>;

export type ApplicationDefinition = Readonly<{
  /** Canonical Keycloak client id first, then legacy aliases carrying the same roles. */
  clientIds: readonly string[];
  name: string;
  description: string;
  roles: Readonly<Record<string, PermissionLabel>>;
}>;

export const applicationCatalog: readonly ApplicationDefinition[] = [
  {
    clientIds: ["core"],
    name: "SKY LAB Core",
    description: "Superadmin ve SkyApp’in arkasındaki kulüp platformu.",
    roles: {
      "users:read": {
        label: "Üye dizinini görme",
        description: "Superadmin’de üye listesini ve kişi kartlarını görebilirsin.",
      },
      "url:access": {
        label: "Kısa bağlantı aracı",
        description: "skyl.app kısa bağlantıları oluşturabilir; kendi bağlantılarını görebilir, düzenleyebilir ve kaldırabilirsin.",
      },
      "url:create": {
        label: "Kısa bağlantı oluşturma",
        description: "skyl.app üzerinde kısa bağlantı oluşturabilirsin.",
      },
      "url:get": {
        label: "Kısa bağlantılarını görme",
        description: "Kendi oluşturduğun kısa bağlantıları listeleyebilirsin.",
      },
      "url:update": {
        label: "Kısa bağlantılarını düzenleme",
        description: "Kendi kısa bağlantılarının hedefini değiştirebilirsin.",
      },
      "url:delete": {
        label: "Kısa bağlantılarını kaldırma",
        description: "Kendi kısa bağlantılarını silebilirsin.",
      },
      "url:moderator": {
        label: "Kısa bağlantı moderatörlüğü",
        description: "Herkesin kısa bağlantılarını görebilir, düzenleyebilir ve kaldırabilirsin.",
      },
      "certificate:issue": {
        label: "Sertifika verme",
        description: "Üyesi olduğun takımların etkinliklerinde katılım sertifikası verebilirsin.",
      },
      "certificate:revoke": {
        label: "Sertifika iptal etme",
        description: "Üyesi olduğun takımların etkinliklerinde verilmiş sertifikaları iptal edebilirsin.",
      },
      "certificate:template:manage": {
        label: "Sertifika şablonu yönetimi",
        description: "Takımların için sertifika şablonu oluşturabilir ve düzenleyebilirsin.",
      },
      "certificate:binding:manage": {
        label: "Sertifika şablonu atama",
        description: "Takımlarının etkinliklerinde hangi sertifika şablonunun kullanılacağını seçebilirsin.",
      },
    },
  },
  {
    clientIds: ["forms", "skyforms", "dotnet"],
    name: "Skyforms",
    description: "Kulübün form ve başvuru aracı.",
    roles: {
      "skyforms:access": {
        label: "Skyforms’a giriş",
        description: "Skyforms yönetim ekranlarını açabilir, iş birlikçisi olduğun formlarla çalışabilirsin.",
      },
      "skyforms:form:manage": {
        label: "Form yönetimi",
        description: "Form oluşturabilir, düzenleyebilir ve yanıtlarını görebilirsin.",
      },
      "skyforms:*": {
        label: "Tüm formlarda tam yetki",
        description: "İş birlikçisi olmasan da her formu, yanıtlarını ve iş akışlarını yönetebilirsin.",
      },
    },
  },
  {
    clientIds: ["skymail"],
    name: "SkyMail",
    description: "Kulübün toplu e-posta ve duyuru aracı.",
    roles: {
      "skymail:access": {
        label: "SkyMail’e giriş",
        description: "SkyMail arayüzünü açabilirsin.",
      },
      "skymail:templates:read": {
        label: "Şablonları görme",
        description: "E-posta şablonlarını görüntüleyebilirsin.",
      },
      "skymail:templates:write": {
        label: "Şablon düzenleme",
        description: "E-posta şablonu oluşturabilir, düzenleyebilir ve silebilirsin.",
      },
      "skymail:lists:read": {
        label: "Alıcı listelerini görme",
        description: "Alıcı listelerini ve içindeki kişileri görüntüleyebilirsin.",
      },
      "skymail:lists:write": {
        label: "Alıcı listesi yönetimi",
        description: "Alıcı listesi oluşturabilir, kişi ekleyip çıkarabilirsin.",
      },
      "skymail:mails:read": {
        label: "Gönderimleri görme",
        description: "Planlanan ve gönderilen e-postaları ve kuyruklarını görüntüleyebilirsin.",
      },
      "skymail:mails:write": {
        label: "E-posta gönderme",
        description: "Toplu ya da tekil e-posta gönderimi oluşturabilirsin.",
      },
      "skymail:mails:send": {
        label: "Gönderim başlatma",
        description: "Hazırlanan gönderimleri yola çıkarabilirsin.",
      },
    },
  },
  {
    clientIds: ["superadmin"],
    name: "Superadmin",
    description: "Kulübün yönetim paneli; yetkileri Core rollerinden ve takım üyeliğinden gelir.",
    roles: {},
  },
];

/**
 * Roles a Site client (for example `skylab-site` or `arge`) may carry. CMS
 * editor access is granted per site, so the same code appears under
 * different client ids and is labelled with that site's name.
 */
export const siteRoleCatalog: Readonly<Record<string, PermissionLabel>> = {
  "cms:access": {
    label: "İçerik düzenleme",
    description: "Bu sitenin CMS editörünü açıp sayfa içeriklerini düzenleyebilirsin; hangi takım sayfalarını değiştirebileceğin takım üyeliğine bağlıdır.",
  },
};

/** Human names of the Site clients known today; other site clients render with their client id. */
export const siteClientNames: Readonly<Record<string, string>> = {
  "skylab-site": "yildizskylab.com",
  arge: "AR-GE sitesi",
};

/**
 * Keycloak's own clients. Their roles (`manage-account`, `view-profile`,
 * `manage-account-links`, …) describe the identity provider, not a SKY LAB
 * application, so the Permissions view leaves them out entirely.
 */
export const keycloakInternalClientIds: ReadonlySet<string> = new Set([
  "account",
  "account-console",
  "admin-cli",
  "broker",
  "realm-management",
  "security-admin-console",
]);
