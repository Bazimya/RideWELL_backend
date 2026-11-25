/**
 * Common passwords of 10+ characters (shorter ones are already rejected by length).
 * This is a starter list. Before launch, replace it with a larger breached-password
 * list (e.g. the top 100 000 from a public breach corpus) loaded from a file.
 */
const LIST = `
1234567890 0123456789 0987654321 1234567891 1234512345 1111111111 0000000000 2222222222
1q2w3e4r5t 1qaz2wsx3edc qwertyuiop qwertyuiop1 qwerty1234 qwerty12345 qwerty123456 asdfghjkl1
asdfghjkl; zxcvbnm123 zaq12wsxcde abcdefghij abcd123456 abc1234567 a123456789 123456789a
123456789q password12 password123 password1234 password12345 passw0rd123 p@ssw0rd123 p@ssword123
password! password!! iloveyou12 iloveyou123 iloveyou1234 football12 football123 baseball123
basketball basketball1 superman123 batman1234 princess12 princess123 sunshine12 sunshine123
welcome123 welcome1234 welcome@123 letmein123 letmein1234 monkey1234 dragon1234 master1234
trustno1234 changeme123 administrator admin12345 admin123456 adminadmin administrator1
qazwsxedcrfv 1q2w3e4r5t6y q1w2e3r4t5 q1w2e3r4t5y6 mypassword mypassword1 yourpassword
starwars123 pokemon123 computer12 computer123 internet123 whatever123 freedom123 liverpool1
liverpool123 chelsea123 arsenal123 manchester manutd1234 barcelona1 realmadrid jesus12345
jesuschrist blessed123 godisgood1 rwanda1234 rwanda12345 kigali1234 kigali12345 ridewell123
ridewell1234 ridewell2026 mtnmomo1234 airtel1234 1234554321 9876543210 147258369a 123123123a
123321123321 1234567890a 1234567890q aa12345678 aaaaaaaaaa
`;

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(LIST.split(/\s+/).filter(Boolean).map((p) => p.toLowerCase()));
