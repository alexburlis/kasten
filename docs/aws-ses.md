# AWS and SES

Kasten sends mail through Amazon SES and through nothing else. This page sets up exactly what the README's [AWS section](../README.md#aws-exactly-what-goes-in-the-account) lists. The examples use the account ID `111122223333`, the region `eu-central-1` (Frankfurt) and the domain `example.com`.

Provider facts on this page were read on 3 and 4 November 2026. The sources are listed at the end. AWS changes its consoles and prices, so check them before you pay.

## Before you start

You need:

- a card, a phone for AWS's identity check, and an authenticator app for MFA;
- an email address that no other AWS account uses. A plus-address of your mailbox works, for example `you+kasten-aws@example.net`. Use a mailbox at another provider, outside Kasten, so that AWS notices reach you when Kasten is down;
- your password manager;
- the AWS CLI v2, if you want the command-line steps.

Do this on the first day. AWS answers the production request within about 96 hours, and you cannot send to other people before it agrees. For the Kasten rehearsal account on 6 November 2026, AWS granted it within two minutes, with a quota of 50,000 messages a day and 14 a second.

## 1. Create the account

Use a separate AWS account for Kasten. Its SES quotas, reputation and automatic enforcement then stay apart from other mail you send through AWS. After severe abuse, for example spam through a stolen SMTP login, AWS can still act on accounts it considers related, so separation is not a guarantee.

1. Sign up at <https://aws.amazon.com> with the email address above.
2. Choose the **paid plan** when AWS asks for an account plan. The free plan ends after six months or when its credits run out, whichever comes first, and AWS then closes the account. The paid plan does not close the account; you pay standard prices for use beyond any credits.
3. Save the root email address and password in your password manager.
4. Sign in as root. Open the account menu at the top right, then **Security credentials**.
5. Under **Multi-factor authentication (MFA)**, choose **Assign MFA device**, and follow the steps for an authenticator app or a passkey.
6. Save the MFA recovery details in your password manager.
7. Do not create access keys for the root user.

Free credits are fine, but do not plan your budget around them.

## 2. Set a budget alert

The alert warns you by email. It does not stop spending by itself; the optional stop below does.

### Optional: stop spending at the budget

AWS has no hard spending cap for an account like this one. Its project spend limits exist only for accounts from its newer sign-up experience, start at $20, and their documentation does not say that they stop SES sending. A budget action comes close: when actual cost reaches 100% of the budget, AWS Budgets attaches a deny-all IAM policy to the users you name. Name every SMTP user and any agent user, and the account's only billable use stops. The first two budgets with actions cost nothing.

The Kasten rehearsal account runs it since 6 November 2026, created with the root session through `aws login`. The budget `kasten-monthly` is 10 USD, with emails at 50% actual, 100% actual and 100% forecast. The customer managed policy `kasten-spend-stop` denies everything. The role `kasten-budgets-action` trusts `budgets.amazonaws.com` for this account only, and may attach and detach only that policy, only to users under `/kasten/` and `/kasten-agent/`. The budget action `APPLY_IAM_POLICY` runs automatically at 100% actual and names the SMTP user and `kasten-agent`. IAM's policy simulator showed the role allowed to attach that policy and nothing else, and `ses:SendRawEmail` denied once the policy is attached. The action has not yet fired for real. AWS updates cost data a few times a day, so spend can pass the limit before the action runs. The action does not limit the root user. Remove the attached policy by hand to send again in the same month.

1. In the console, open **Billing and Cost Management** > **Budgets** > **Create budget**.
2. Choose **Use a template**, then **Monthly cost budget**.
3. Name it `kasten-monthly`, and set the amount to `5.00` USD.
4. Enter your email address as the recipient. Use an address outside Kasten.
5. Choose **Create budget**.

The template emails the recipient when the actual cost exceeds the amount, or when AWS forecasts that it will. Budgets and their email alerts cost nothing.

Check spend in the Billing console. Never call the Cost Explorer API (`aws ce …`): each request costs $0.01.

## 3. Choose the SES region and pricing

1. Choose one region for SES, for example `eu-central-1`. Its SMTP endpoint is `email-smtp.eu-central-1.amazonaws.com`. Some regions have no SMTP endpoint, for example Milan and Zurich.
2. Open the SES console in that region.
3. Open the **Pricing plan** page and choose **Cancel plan**, so the region uses **à la carte** pricing. If the page shows no current plan, the region is already on à la carte. AWS's guide names the page but not its place in the console menu; that has not yet been checked in the live console.

Or with the CLI:

```sh
aws sesv2 put-account-pricing-attributes --region eu-central-1 --plan NONE
aws sesv2 get-account --region eu-central-1 --query 'PricingAttributes.CurrentPlan'
```

The second command prints `NONE` for à la carte.

Why: since 21 July 2026, new SES accounts start on the **Essentials** plan. Essentials has no monthly fee, but charges $0.16 per 1,000 recipients. À la carte charges $0.10 per 1,000 recipients plus $0.12 per GB of attachments. If AWS put you on Essentials and you never chose a plan, the first cancellation takes effect at once. Plans apply per region.

Do not turn on these paid extras: dedicated IPs, Virtual Deliverability Manager, Mail Manager, SES receiving or the Pro and Enterprise plans. Kasten needs none of them. Shared sending IPs cost nothing extra.

## 4. Create the domain identity

Create one identity for each domain you send from.

1. In the SES console, choose **Configuration** > **Identities** > **Create identity**.
2. Choose **Domain**, and enter `example.com`.
3. Expand **Advanced DKIM settings**. Choose **Easy DKIM** and **RSA_2048_BIT**.
4. Clear **Publish DNS records to Route53**, unless your DNS is in Route 53 in this account.
5. Keep **DKIM signatures** enabled.
6. Choose **Create identity**.
7. On the identity's **Authentication** tab, expand **Publish DNS records**. Copy the three CNAME records.
8. Create the three records at your DNS host, as in [DNS](dns.md). Enter each name exactly as shown.

Or with the CLI:

```sh
aws sesv2 create-email-identity --region eu-central-1 --email-identity example.com \
  --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT \
  --query 'DkimAttributes.{Tokens:Tokens,Zone:SigningHostedZone}'
```

Each record is `<token>._domainkey.example.com CNAME <token>.<zone>`. In `eu-central-1` and most regions the zone is `dkim.amazonses.com`, but eleven regions use their own, `dkim.<region>.amazonses.com` ([DNS](dns.md#the-records) lists them). `kasten dns` follows that table. Read the zone from the output rather than assuming it, and where it differs from what `kasten dns` prints, use the zone SES shows.

Put the three tokens into `kasten.json` as `"dns": {"sesDkimTokens": {"example.com": ["<token1>", "<token2>", "<token3>"]}}`. `kasten dns` then prints the three records with the real tokens, as in [DNS](dns.md#print-your-records).

SES looks for the records for up to 72 hours. Check the status:

```sh
aws sesv2 get-email-identity --region eu-central-1 --email-identity example.com \
  --query '{Verified:VerifiedForSendingStatus,Dkim:DkimAttributes.Status}'
```

The identity is ready when it prints `true` and `SUCCESS`. The console then shows the identity as **Verified** and DKIM as **Successful**.

## 5. Optional: custom MAIL FROM

By default, SES uses a subdomain of `amazonses.com` as the envelope sender. Your mail still passes DMARC through DKIM. A custom MAIL FROM makes SPF align with your domain too. Skip it unless you want that.

1. Choose a subdomain that you do not use for anything else, for example `bounce.example.com`. Kasten must not receive mail for it.
2. On the identity's page, edit **Custom MAIL FROM domain**. Enter the subdomain, and set **Behavior on MX failure** to **Use default MAIL FROM domain**.
3. Create exactly one MX record and one TXT record for the subdomain, as in [DNS](dns.md#optional-records). With `"customMailFrom": "bounce"` in the `dns` part of `kasten.json`, `kasten dns` prints both.

Or with the CLI:

```sh
aws sesv2 put-email-identity-mail-from-attributes --region eu-central-1 \
  --email-identity example.com --mail-from-domain bounce.example.com \
  --behavior-on-mx-failure USE_DEFAULT_VALUE
```

If SES does not find the MX record within 72 hours, the status becomes **Failed**, and you must start this step again.

## 6. Request production access

A new account is in the SES sandbox. In the sandbox you can send only to addresses you have verified, at most 200 messages a day. The sandbox applies per region.

1. In the SES console, open **Account dashboard**.
2. In the box that says your account is in the sandbox, choose **View Get set up page**, then **Request production access**.
3. Choose **Transactional** as the mail type.
4. Enter a website URL that you control, for example your homepage on the domain.
5. Add one or two contact addresses outside Kasten.
6. Choose **English** as the contact language.
7. Read the acknowledgement and check it only if it is true: you send only to people who expect your mail, and you handle bounces and complaints.
8. Choose **Submit request**.

Or with the CLI, after you save the use-case text below as `use-case.txt`:

```sh
aws sesv2 put-account-details --region eu-central-1 \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://example.com \
  --additional-contact-email-addresses you+kasten-aws@example.net \
  --contact-language EN \
  --use-case-description "$(cat use-case.txt)"
```

AWS marks the use-case field as deprecated, but the CLI still accepts it. If AWS asks for more detail, answer with the same text.

Describe the real use. This wording fits one person or a household; change it if your use differs:

```text
This account sends personal email for one person at example.com.
I run my own mail server (Stalwart). SES is only its outgoing relay, over SMTP on port 587.
Every message is written by a person to someone they correspond with.
There are no mailing lists, newsletters, marketing or automated bulk mail.
Expected volume is under 50 messages a day. The server caps outgoing mail at 100 recipients a day.
The account-level suppression list is on for bounces and complaints.
SES forwards bounce and complaint notices to the sender's address, and the sender reads them.
I do not resend to addresses that bounced.
```

You cannot edit the request while AWS reviews it. If AWS refuses, you cannot send. Stop and read [security](security.md#when-to-stop-and-decide).

## 7. Check the suppression list

The account-level suppression list stops SES from sending again to addresses that hard-bounced or complained. Accounts that started using SES after 25 November 2019 have it on for both by default. It applies per region.

1. In the SES console, open **Configuration** > **Suppression list**.
2. Under **Account-level settings**, check that it is **Enabled** for **Bounce** and **Complaint**.

Or with the CLI:

```sh
aws sesv2 get-account --region eu-central-1 --query 'SuppressionAttributes.SuppressedReasons'
```

It prints `BOUNCE` and `COMPLAINT`. Messages to a suppressed address are accepted, not delivered, and still count against your quota.

## 8. Create one SMTP user per domain

Each SMTP user is an IAM user whose only permission is `ses:SendRawEmail` on one identity. Its access key becomes the SMTP login.

Do not use the SES console's **Create SMTP credentials** button. It attaches AWS's `AmazonSesSendingAccess` policy, which allows sending as every identity in the account.

The policy for `example.com`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KastenSmtpSendOneDomain",
      "Effect": "Allow",
      "Action": "ses:SendRawEmail",
      "Resource": "arn:aws:ses:eu-central-1:111122223333:identity/example.com"
    }
  ]
}
```

AWS documents that a `Resource` of identity ARNs limits which identities a user can send from, and that SMTP needs `ses:SendRawEmail`. A custom MAIL FROM domain is a setting of the `example.com` identity, not a separate identity. AWS also documents condition keys such as `ses:FromAddress` for `SendRawEmail`, but does not say whether SES applies them to SMTP. Kasten uses no condition keys; it relies only on the identity resource.

In the console, as root or an administrator:

1. Open **IAM** > **Users** > **Create user**. Name it `kasten-smtp-example-com`. Do not give it console access.
2. Skip the permissions page, and create the user.
3. Open the user. Choose **Add permissions** > **Create inline policy** > **JSON**. Paste the policy above, and name it `ses-send-example-com`.
4. On the **Security credentials** tab, choose **Create access key**. Choose **Application running outside AWS**.
5. Save the access key ID and the secret access key in your password manager.
6. Write the secret access key alone into a file with mode `0600`, for example `iam-secret.txt`.

With the CLI and the [setup permissions](#setup-permissions), after you save the policy above as `smtp-policy.json`:

```sh
aws iam create-user --user-name kasten-smtp-example-com --path /kasten/ \
  --permissions-boundary arn:aws:iam::111122223333:policy/kasten-smtp-boundary
aws iam put-user-policy --user-name kasten-smtp-example-com \
  --policy-name ses-send-example-com --policy-document file://smtp-policy.json
(umask 077; aws iam create-access-key --user-name kasten-smtp-example-com \
  --query 'AccessKey.SecretAccessKey' --output text > iam-secret.txt)
aws iam list-access-keys --user-name kasten-smtp-example-com \
  --query 'AccessKeyMetadata[0].AccessKeyId' --output text
```

The third command writes the secret access key to a `0600` file and prints nothing. The fourth prints the access key ID, which is not secret. Save both in your password manager.

Repeat for each domain with different file names (for example `ses-pilot-user/password` and `ses-primary-user/password`). Add one `relays` entry per domain; never overwrite the pilot domain’s files with production credentials. Then put that domain’s SMTP login on the VPS. `kasten.json` names two files for it: `relays[].usernameFile` and `relays[].passwordFile` (`ses-smtp-username` and `ses-smtp-password` in `kasten.example.json`). Both live in `/var/lib/kasten/cli/` on the VPS, owned by `kasten:kasten` with mode `0600`; `kasten setup` refuses a file that group or others can read, and `kasten-cli` refuses to run while any file there does not belong to `kasten:kasten` or gives group or others any access.

The first domain in `kasten.json` is Stalwart's default domain. Its SMTP user also carries Stalwart's delivery status notifications (DSNs), which come from `MAILER-DAEMON@<first domain>`. So its policy's `Resource` must be that domain's identity, as for any other domain.

Run these from the computer that holds `iam-secret.txt`; `<vps>` is the address you use for SSH to the VPS, normally its Tailscale name. The VPS must already have the images and `KASTEN_VERSION`, as in steps 1 to 5 of the [deploy order](../deploy/README.md#order-of-use). If it is not ready yet, delete `iam-secret.txt` now, and write it again from your password manager when it is.

```sh
aws iam list-access-keys --user-name kasten-smtp-example-com \
  --query 'AccessKeyMetadata[0].AccessKeyId' --output text |
  ssh root@<vps> 'setpriv --reuid=kasten --regid=kasten --init-groups sh -c "umask 077 && cat >/var/lib/kasten/cli/ses-smtp-username"'
ssh root@<vps> 'umask 077 && test ! -e /var/lib/kasten/cli/ses-smtp-password && kasten-cli aws smtp-password --region eu-central-1 --out /etc/kasten/state/ses-smtp-password && setpriv --reuid=kasten --regid=kasten --init-groups mv /var/lib/kasten/cli/state/ses-smtp-password /var/lib/kasten/cli/ses-smtp-password' < iam-secret.txt
```

The first command writes the SMTP user name, which is the access key ID, as the `kasten` user, so the file is `kasten`'s with mode 0600. If you created the key in the console, write the ID into that file the same way; it is not secret. `/var/lib/kasten/cli` belongs to `kasten`, so root never writes there itself, as in [How to run the commands](operations.md#how-to-run-the-commands-on-this-page): it would follow a link that `kasten` left there.

The second command sends the secret access key over SSH to `kasten aws smtp-password`, on standard input. The command derives the password for the region in `--region`, and writes it only to the `--out` file. `--out` writes a new `0600` file and refuses to replace an existing one. The command never prints the password, because the CLI container's standard output also goes to journald, even when the host shell redirects it. In the Lima VM test of Fedora 45 on 6 November 2026, the output of `kasten-cli help >/dev/null 2>&1` reached the journal. Inside the container, `/etc/kasten/state` is the writable bind of `/var/lib/kasten/cli/state`; the rest of `/etc/kasten` is read-only. The new file belongs to `kasten:kasten`, because rootless Podman maps the container's root to the host user `kasten`. The `mv`, which runs as `kasten`, then puts the file at the `relays[].passwordFile` path and keeps its owner and mode. The secret access key itself never reaches the VPS's disk. `deploy/test/run.sh` stage `server` pipes synthetic input through `kasten-cli aws smtp-password` the same way, and moves the result into `cli/` as `kasten`.

For another domain, use that domain's file names in both commands.

The password works only in the region it was derived for. `kasten setup` reads both files and sets them on Stalwart's SES route.

The algorithm, from the SES guide, is an HMAC-SHA256 chain:

```text
kDate     = HMAC-SHA256(key = "AWS4" + secret, data = "11111111")
kRegion   = HMAC-SHA256(kDate, region)
kService  = HMAC-SHA256(kRegion, "ses")
kTerminal = HMAC-SHA256(kService, "aws4_request")
kMessage  = HMAC-SHA256(kTerminal, "SendRawEmail")
password  = Base64(0x04 || kMessage)
```

Delete `iam-secret.txt` once the secret access key is in your password manager and the SMTP password is on the server. Never derive the password from temporary credentials; SES does not accept them.

Kasten connects to `email-smtp.eu-central-1.amazonaws.com` on port 587, with `STARTTLS` required and the certificate verified.

Use the same region in three places: `--region` above, `relays[].host` (`email-smtp.<region>.amazonaws.com`) and `dns.sesRegion` in `kasten.json`. Kasten does not check that they match. With another region in `relays[].host`, the SMTP login fails, because SES SMTP credentials differ per region. `dns.sesRegion` sets the DKIM CNAME targets and the custom MAIL FROM record that `kasten dns` prints; with the wrong region, both can be wrong.

## 9. Sending limits

| Limit                   | Value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| Sandbox                 | Verified recipients only, 200 messages per 24 hours, 1 message per second |
| After production access | Set by AWS for your use case; check it on the **Account dashboard**       |
| Message size            | 40 MB after base64 encoding. Kasten limits outgoing mail to 38 MB         |
| Recipients per message  | 50, across To, Cc and Bcc                                                 |
| Kasten's own cap        | 100 outgoing recipients per day                                           |

Quotas count recipients, not messages, over a rolling 24 hours. Check them with `aws sesv2 get-account --region eu-central-1 --query SendQuota`. Kasten's daily cap applies only to mail sent through Stalwart. It does not limit someone who steals the SMTP credential.

## Setup permissions

Skip this section if you do the AWS steps yourself in the console.

### The simpler way: lend the agent your console session

With AWS CLI 2.32 or later, the agent needs no setup user and no access key of yours. While you are signed in to the console as root, the agent runs `aws login --profile kasten-root` on your computer. Your browser shows the sessions you are signed in to; choose the Kasten account. The CLI then holds temporary credentials of that session and refreshes them while its refresh token is valid, and the agent runs the CLI steps of sections 2 to 8 and [Read-only user](#read-only-user-for-the-weekly-checks) with them. When it is done, it runs `aws logout --profile kasten-root`, which deletes the cached credentials; an access token already loaded stays valid for up to 15 minutes. Used on 6 November 2026 for the Kasten rehearsal account: the boundary policy, the budget, the pricing plan, the identity, the production request, one SMTP user with the boundary and the `kasten-ops` user.

### The setup user

Without `aws login`, an agent that does the AWS steps needs a temporary IAM user, `kasten-setup`. Its policy allows only these effects:

- create and read SES domain identities, and set custom MAIL FROM;
- read the SES account, request production access, set the pricing plan and the suppression list;
- create SMTP users under the IAM path `/kasten/`, give them one inline policy, create their access keys and read them back.

A user that can create users and write their policies could otherwise create an administrator. A permissions boundary prevents that. Every SMTP user must carry the `kasten-smtp-boundary` policy, and a boundary caps what any of the user's policies can grant.

### The boundary policy

Create it as a customer managed policy named `kasten-smtp-boundary`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KastenSmtpSendOnly",
      "Effect": "Allow",
      "Action": "ses:SendRawEmail",
      "Resource": "arn:aws:ses:*:111122223333:identity/*"
    }
  ]
}
```

A boundary grants nothing by itself. It caps each SMTP user at sending through this account's SES identities, whatever inline policy the user has. The user's own policy, from step 8, narrows that to one identity in one region.

### The setup policy

Attach it to `kasten-setup` as an inline policy named `kasten-setup`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SesAccount",
      "Effect": "Allow",
      "Action": [
        "ses:GetAccount",
        "ses:ListEmailIdentities",
        "ses:PutAccountDetails",
        "ses:PutAccountPricingAttributes",
        "ses:PutAccountSuppressionAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SesIdentities",
      "Effect": "Allow",
      "Action": [
        "ses:CreateEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes"
      ],
      "Resource": "arn:aws:ses:*:111122223333:identity/*"
    },
    {
      "Sid": "SmtpUsersOnlyWithBoundary",
      "Effect": "Allow",
      "Action": ["iam:CreateUser", "iam:PutUserPolicy"],
      "Resource": "arn:aws:iam::111122223333:user/kasten/*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::111122223333:policy/kasten-smtp-boundary"
        }
      }
    },
    {
      "Sid": "SmtpUserKeys",
      "Effect": "Allow",
      "Action": ["iam:CreateAccessKey", "iam:ListAccessKeys", "iam:GetUser", "iam:GetUserPolicy"],
      "Resource": "arn:aws:iam::111122223333:user/kasten/*"
    }
  ]
}
```

Replace `111122223333` with your account ID in both policies.

| Statement                   | What it allows                                                                                         | Used in            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------ |
| `SesAccount`                | Read the SES account; request production access; set the pricing plan and the suppression list         | Steps 3, 6 and 7   |
| `SesIdentities`             | Create and read this account's SES identities, and set their custom MAIL FROM                          | Steps 4 and 5      |
| `SmtpUsersOnlyWithBoundary` | Create a user under `/kasten/`, and write its inline policy, only if it carries `kasten-smtp-boundary` | Step 8             |
| `SmtpUserKeys`              | Create and list access keys, and read the user and its policy, for users under `/kasten/` only         | Step 8, and checks |

The `SesAccount` actions have no resource ARN in IAM, so `*` is the only resource they accept. IAM checks the `iam:PermissionsBoundary` condition key on `CreateUser` and `PutUserPolicy`, so `kasten-setup` cannot create an SMTP user without the boundary. It has no permission to remove a boundary, change any managed policy, attach one, delete anything, or touch a user outside `/kasten/`, itself included. Create the budget as root, in step 2.

Both policies follow AWS's documented actions, resources and condition keys. The boundary policy is in live use since 6 November 2026: IAM shows it on the SMTP user of the rehearsal account. The setup policy has not yet been tested in a live AWS account, because the rehearsal used `aws login` instead.

### Create the setup user

Do this signed in as root, or let the agent drive your signed-in console session while you watch.

1. Open **IAM** > **Policies** > **Create policy** > **JSON**. Paste the boundary policy, with your account ID. Name it `kasten-smtp-boundary`.
2. Open **IAM** > **Users** > **Create user**. Name it `kasten-setup`. Do not give it console access. Keep the default path `/`, so the user cannot change itself.
3. Open the user. Choose **Add permissions** > **Create inline policy** > **JSON**. Paste the setup policy, with your account ID. Name it `kasten-setup`.
4. On the **Security credentials** tab, choose **Create access key** > **Command Line Interface (CLI)**.
5. Save the access key in your password manager. The agent reads it from there into a `0600` AWS credentials file.

### Delete it when setup is done

Delete the setup user as soon as the SMTP users exist and production access is granted.

1. Open **IAM** > **Users**, and select `kasten-setup`.
2. Choose **Delete**. Type the user name to confirm. The console deletes its access keys and inline policy too.
3. Delete the key from your password manager and from the agent's credentials file.

Or, as an administrator with the CLI:

```sh
aws iam list-access-keys --user-name kasten-setup
aws iam delete-access-key --user-name kasten-setup --access-key-id <key-id>
aws iam delete-user-policy --user-name kasten-setup --policy-name kasten-setup
aws iam delete-user --user-name kasten-setup
```

Keep `kasten-smtp-boundary`. The SMTP users still use it. After setup, the account holds only the root user, the SMTP users, the boundary policy, the budget, the SES identities and, if you create it, the read-only `kasten-ops` user below.

## Read-only user for the weekly checks

Skip this section if you do the [weekly checks](operations.md#weekly-checks) yourself in the console.

An agent that does the weekly SES and spend checks needs a key that can only read. Create the IAM user `kasten-ops` for it. Its inline policy, named `kasten-ops-read`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SesAccountRead",
      "Effect": "Allow",
      "Action": ["ses:GetAccount", "ses:ListEmailIdentities"],
      "Resource": "*"
    },
    {
      "Sid": "SesIdentityRead",
      "Effect": "Allow",
      "Action": "ses:GetEmailIdentity",
      "Resource": "arn:aws:ses:*:111122223333:identity/*"
    },
    {
      "Sid": "BudgetRead",
      "Effect": "Allow",
      "Action": "budgets:ViewBudget",
      "Resource": "arn:aws:budgets::111122223333:budget/kasten-monthly"
    }
  ]
}
```

As for the setup policy, `ses:GetAccount` and `ses:ListEmailIdentities` accept only `*` as their resource. The policy allows no write and no Cost Explorer call.

Do this signed in as root. The `kasten-setup` user cannot create it, because it can create users only under `/kasten/`.

1. Open **IAM** > **Users** > **Create user**. Name it `kasten-ops`, with the path `/kasten-ops/`. Do not give it console access.
2. Open the user. Choose **Add permissions** > **Create inline policy** > **JSON**. Paste the policy above, with your account ID. Name it `kasten-ops-read`.
3. On the **Security credentials** tab, choose **Create access key** > **Command Line Interface (CLI)**.
4. Save the access key in your password manager. The agent uses it on your computer, never on the mail server.

[Weekly checks](operations.md#weekly-checks) 1 and 2 list the two commands it runs. On 6 November 2026, in a new account, `kasten-ops` read the budget without the account setting **IAM user and role access to Billing information**, and AWS refused it `iam:ListUsers`. If `aws budgets describe-budget` is refused with `AccessDenied`, sign in as root once, open the account page, edit **IAM user and role access to Billing information**, choose **Activate IAM Access**, and run the command again. The policy has not yet been tested in a live AWS account.

## Remove a sending domain

Use this after you remove a domain from Kasten, for example the pilot domain after [Remove a pilot domain](operations.md#remove-a-pilot-domain). Do it signed in as root: `kasten-setup` and `kasten-ops` cannot delete anything.

1. Delete the domain's SES identity: in the SES console, choose **Configuration** > **Identities**, select the domain and choose **Delete**. Or with the CLI: `aws sesv2 delete-email-identity --region eu-central-1 --email-identity pilot.example.com`.
2. Delete the domain's SMTP user, as in [Delete it when setup is done](#delete-it-when-setup-is-done), with the user's own names: for example the user `kasten-smtp-pilot-example-com` and the policy `ses-send-pilot-example-com`. The console deletes its access keys and inline policy too.
3. On the VPS, delete the two files that the domain's `relays` entry named. Delete the domain's items from your password manager.
4. Remove the domain's DKIM CNAME records, and its custom MAIL FROM records if you created them.

These steps have not yet been tested in a live AWS account.

## What not to create

- No S3 buckets, Lambda functions, SNS topics or SES receiving rules.
- No SES dedicated IPs, Virtual Deliverability Manager, Mail Manager or Pro or Enterprise plan.
- No Cost Explorer API calls.
- No root access keys, and no setup key left behind.

## Sources

Read on 3 and 4 November 2026.

- [Choosing a plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html): the free and paid account plans.
- [MFA for the root user](https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-mfa-for-root.html).
- [Using a budget template](https://docs.aws.amazon.com/cost-management/latest/userguide/budget-templates.html) and [AWS Budgets pricing](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/).
- [AWS Cost Explorer pricing](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/pricing/): $0.01 per API request.
- [SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html): SMTP endpoints, the regions without one, DKIM domains and feedback endpoints.
- [Regions and Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/regions.html): what applies per region.
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/), [Choose and manage your plan](https://docs.aws.amazon.com/ses/latest/dg/pricing-plans.html), [PutAccountPricingAttributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutAccountPricingAttributes.html) and [GetAccount](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html).
- [Creating identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) and [Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html).
- [Using a custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html).
- [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) and [PutAccountDetails](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutAccountDetails.html).
- [The account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html).
- [Obtaining SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html): the password algorithm, and no temporary credentials.
- [Connecting to an SES SMTP endpoint](https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html).
- [Service quotas in SES](https://docs.aws.amazon.com/ses/latest/dg/quotas.html): message size and recipients per message.
- [Identity and access management in SES](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html): identity resources and condition keys.
- Actions, resources and condition keys for [SES v2](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html), [SES](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html) and [IAM](https://docs.aws.amazon.com/service-authorization/latest/reference/list_iam.html).
- [Permissions boundaries for IAM entities](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html).
